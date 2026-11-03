import { randomBytes } from 'node:crypto';
import { getChatgptWeb, setChatgptWeb } from './store.mjs';
import { serial } from './queue.mjs';
import { withLock } from './lock.mjs';
import { Dot } from './dot.mjs';
import { cleanUrl, extractLinks } from './links.mjs';
import { openBridge } from './dot-capture.mjs';

/**
 * 固定 ChatGPT 网页会话搜索（驱动页面）：用户指定一个会话网址，之后所有搜索都在这个会话里进行。
 *   发送：经 chrome-agent-bridge 在该会话的标签页里填字、按回车 —— 页面自己完成 Sentinel 校验与发送。
 *         （实测：用页面 SDK 的令牌从 Node 或页面 fetch 自己拼请求会被 403，见 docs/chatgpt-session-websearch-plan.zh.md §12）
 *   读取：GET /backend-api/conversation/<id>（普通带登录态的 GET，登录态复用 Dot 抓取的那份），
 *         来源取自工具节点的 search_result_groups（结构化：标题 / 网址 / 摘要 / 日期），不依赖模型吐 JSON。
 * 模型由页面当前的选择决定，请求里不能指定。
 */
export class ChatgptWebError extends Error { constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); } }
const E = (code, message) => new ChatgptWebError(code, message);
// 计入熔断：登录失效 / 被拦 / 会话没了 / 页面改版找不到输入框 / 发送后消息始终没出现。没标签页、没桥接、超时、没配置等不计
const COUNTED = new Set(['chatgpt_web_unauthorized', 'chatgpt_web_blocked', 'chatgpt_web_session_invalid', 'chatgpt_web_ui_changed', 'chatgpt_web_send_failed']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── 纯函数（有单测）─────────
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** https://chatgpt.com/c/<uuid> 或 https://chatgpt.com/g/g-p-<32hex>-<slug>/c/<uuid> */
export function parseSessionUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com') return null;
  const m = u.pathname.match(new RegExp(`^(?:/g/(g-p-[0-9a-f]{32})[^/]*)?/c/(${UUID})/?$`, 'i'));
  return m ? { conversation_id: m[2].toLowerCase(), project_id: m[1]?.toLowerCase() ?? null } : null;
}
/** 去掉回答里的引用标记：<Cite ref="…"/> 与私有区字符包起来的引用 */
export const stripCitations = (t) => String(t ?? '').replace(/<Cite\b[^>]*\/>/g, '').replace(/[^]*/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// 页面会把我们要求的结束标记包进 <escape>…</escape>，去掉标记后要把空壳也清掉
const stripMarker = (t, marker) => stripCitations(String(t).split(marker).join('').replace(/<escape>\s*<\/escape>/g, '').replace(/<\/?escape>/g, ''));
export function buildPrompt(mode, a, n, marker) {
  const rules = 'Do not use any other tool, do not save or remember anything, do not ask me questions.';
  const recency = a.recency ? ` Prefer results from the last ${a.recency}.` : '';
  const q = a.query.trim().replace(/\s+/g, ' ');
  // 单行：输入框里换行不会触发发送，但多行文本在编辑器里的行为不可控
  if (mode === 'quick') return `[API call — web search backend] Use ONLY your built-in web search, one search is enough. ${rules}${recency} Query: ${q} — After searching, reply with only this exact text and nothing else: ${marker}`;
  return `[API call — web research backend] Use ONLY your built-in web search, up to ${Math.max(2, Math.ceil(n / 2))} searches, and cross-check the sources. ${rules}${recency} Question: ${q} — Reply in the question's language with a concise factual answer, then a "Sources" list of markdown links with full URLs (up to ${n}). Then on its own last line write exactly: ${marker}`;
}
const textOf = (m) => (m?.content?.parts ?? []).filter((p) => typeof p === 'string').join('');
/**
 * 在会话的消息树里找到“我这条”（用户消息里含本次随机标记）并读出它的结果。
 * done：这一轮末端是一条 end_turn 的助手文本（有子节点的不算）。但页面会先写一条前言（也是 end_turn）再写正式回答，
 * 前言在正式回答出现前同样是叶子，所以 done 还不够：末端文本含结束标记（hasMarker）才算确定完成，否则调用方要等内容稳定。
 */
export function readTurn(mapping, marker) {
  const nodes = Object.values(mapping ?? {});
  const user = nodes.find((n) => n.message?.author?.role === 'user' && textOf(n.message).includes(marker));
  if (!user) return null;
  const desc = []; const stack = [...(user.children ?? [])]; const seen = new Set();
  while (stack.length) { const id = stack.pop(); if (seen.has(id) || !mapping[id]) continue; seen.add(id); desc.push(mapping[id]); stack.push(...(mapping[id].children ?? [])); }
  desc.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
  const entries = []; let model = null;
  for (const n of desc) {
    const md = n.message?.metadata ?? {};
    for (const g of md.search_result_groups ?? []) for (const e of g.entries ?? []) if (/^https?:\/\//i.test(e?.url ?? '')) entries.push(e);
    if (n.message?.author?.role === 'assistant' && md.resolved_model_slug) model = md.resolved_model_slug;
  }
  // 回答可能在末端之前的某条 end_turn 节点里（末端有时只是一条 <escape>[[END:…]]</escape> 的收尾），所以文本取"最后一条清理后非空的回答"，完成与否看末端
  const finals = desc.filter((n) => n.message?.author?.role === 'assistant' && n.message.content?.content_type === 'text' && n.message.recipient === 'all' && n.message.end_turn === true && n.message.status === 'finished_successfully');
  const leaf = finals.filter((n) => !(n.children ?? []).length).at(-1);
  const text = finals.map((n) => stripMarker(textOf(n.message), marker)).filter(Boolean).at(-1) ?? '';
  return { done: !!leaf, hasMarker: !!leaf && textOf(leaf.message).includes(marker), text, entries, model, searched: desc.some((n) => n.message?.author?.role === 'tool') || entries.length > 0 };
}
/** 搜索结果条目 → {title, url, summary, published}；去重、去 utm_source=chatgpt.com */
export function toResults(entries, n) {
  const by = new Map();   // 同一网址在工具节点和助手节点里各出现一次，摘要 / 日期只在助手节点那份里 → 合并补全
  const pub = (d) => (typeof d === 'number' ? new Date(d * 1000).toISOString().slice(0, 10) : String(d));
  for (const e of entries) {
    const url = cleanUrl(e.url);
    const cur = by.get(url) ?? { title: '', url, summary: '' };
    cur.title ||= String(e.title ?? '').trim();
    cur.attribution ||= e.attribution;
    cur.summary ||= String(e.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!cur.published && e.pub_date) cur.published = pub(e.pub_date);
    by.set(url, cur);
  }
  return [...by.values()].slice(0, n).map(({ attribution, ...r }) => ({ ...r, title: r.title || attribution || r.url }));
}
/** 标签页：地址里含该会话 id */
export const pickSessionTab = (tabs, conversationId) => tabs.find((t) => /^https:\/\/chatgpt\.com\//.test(t.url ?? '') && t.url.toLowerCase().includes(`/c/${conversationId}`)) ?? null;

// ───────── 配置 ─────────
/** 环境变量 SUBPOW_CHATGPT_SESSION_URL 优先（多机 / 测试），其次配置文件。没配置就报错：不猜、不自动新建会话 */
export function sessionConfig() {
  const cfg = getChatgptWeb();
  const url = process.env.SUBPOW_CHATGPT_SESSION_URL || cfg.session_url;
  if (!url) throw E('chatgpt_web_no_session', 'no ChatGPT session is configured — set the fixed conversation first: node server/bin/subpow.mjs web session set <https://chatgpt.com/…/c/<id> URL>');
  const p = parseSessionUrl(url);
  if (!p) throw E('chatgpt_web_no_session', `configured session URL is not a ChatGPT conversation URL: ${String(url).slice(0, 80)}`);
  return { url, ...p, browser: cfg.browser ?? undefined };
}

// ───────── 与页面、接口打交道 ─────────
/** 把 Dot 客户端 / bridge 的错误翻译成本后端的错误码 */
function wrap(e) {
  if (e instanceof ChatgptWebError) return e;
  const map = { dot_no_credentials: 'chatgpt_web_no_credentials', dot_unavailable: 'chatgpt_web_unauthorized', dot_blocked: 'chatgpt_web_blocked', dot_rate_limited: 'chatgpt_web_rate_limited', dot_network: 'chatgpt_web_network', dot_bad_output: 'chatgpt_web_bad_output', dot_capture_no_bridge: 'chatgpt_web_no_bridge', dot_capture_bridge: 'chatgpt_web_bridge' };
  if (e?.code && map[e.code]) {
    if (e.code === 'dot_unavailable' && /404/.test(e.message)) return E('chatgpt_web_session_invalid', 'the configured conversation was not found (deleted, or it belongs to another account)');
    const msg = e.code === 'dot_no_credentials' ? 'no ChatGPT login state saved — run: node server/bin/subpow.mjs dot capture (the login state is shared with the Dot backend)' : e.message;
    return E(map[e.code], msg);
  }
  return e;
}
/** 网络抖动（连接被重置等）重试几次；其它错误原样抛出 */
async function retryNetwork(fn, tries = 3, delayMs = 1500) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (e?.code !== 'chatgpt_web_network' || i >= tries) throw e; await sleep(delayMs * i); }
  }
}
async function conversationApi() {
  const d = new Dot(); d.load();
  return (id) => retryNetwork(() => d.api('GET', `/backend-api/conversation/${id}`).catch((e) => { throw wrap(e); }));
}
function assertUsable(conv, sess) {
  if (conv.is_archived) throw E('chatgpt_web_session_invalid', 'the configured conversation is archived — un-archive it or set another session');
  if (sess.project_id && conv.gizmo_id && conv.gizmo_id !== sess.project_id) throw E('chatgpt_web_session_invalid', 'the conversation does not belong to the project in the configured URL');
}

const COMPOSER = `(() => { const els = [...document.querySelectorAll('div.ProseMirror[contenteditable="true"]')].filter((e) => e.offsetParent !== null); return els.find((e) => e.getAttribute('role') === 'textbox') ?? els[0] ?? null; })()`;
/** 在会话标签页里填字并回车。页面自己负责校验与发送；返回后由调用方轮询会话确认消息真的出现 */
async function typeAndSend(bridge, tab, text, browser) {
  const b = browser ? { browser } : {};
  const att = await bridge.call('browser_cdp_attach', { tabId: tab.id, captureEvents: false, leaseTtlMs: 60_000, ownerLabel: 'subscription-powers chatgpt_web', ...b });
  const send = (method, params = {}) => bridge.call('browser_cdp_send', { sessionId: att.sessionId, method, params });
  const ev = async (expression) => { const r = (await send('Runtime.evaluate', { expression, returnByValue: true })).result; if (r?.exceptionDetails) throw E('chatgpt_web_ui_changed', `page script failed: ${String(r.exceptionDetails.exception?.description ?? '').slice(0, 120)}`); return r?.result?.value; };
  try {
    const state = await ev(`(() => { const c = ${COMPOSER}; return c ? { text: c.innerText.trim().length, visible: document.visibilityState } : null; })()`);
    if (!state) throw E('chatgpt_web_ui_changed', 'cannot find the message box on the session page (ChatGPT web UI changed, or the page is not a conversation)');
    if (state.text > 0) throw E('chatgpt_web_composer_busy', 'the session page has an unsent draft in its message box — clear it (this backend never overwrites your draft)');
    await ev(`${COMPOSER}.focus()`);
    await send('Input.insertText', { text });
    await sleep(500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    return { visibility: state.visible };
  } catch (e) { await clearComposer(send).catch(() => {}); throw e; }
  finally { await bridge.call('browser_cdp_detach', { sessionId: att.sessionId }).catch(() => {}); }
}
const clearComposer = (send) => send('Runtime.evaluate', { expression: `(() => { const c = ${COMPOSER}; if (!c) return; c.focus(); document.execCommand('selectAll'); document.execCommand('delete'); })()`, returnByValue: true });
/** 发送没成功（消息没出现）时，清掉我们填进去的字，免得留成草稿挡住下一次 */
async function discardDraft(bridge, tab, browser) {
  const att = await bridge.call('browser_cdp_attach', { tabId: tab.id, captureEvents: false, leaseTtlMs: 30_000, ownerLabel: 'subscription-powers chatgpt_web cleanup', ...(browser ? { browser } : {}) }).catch(() => null);
  if (!att) return;
  try { await clearComposer((method, params) => bridge.call('browser_cdp_send', { sessionId: att.sessionId, method, params })); }
  catch {} finally { await bridge.call('browser_cdp_detach', { sessionId: att.sessionId }).catch(() => {}); }
}

// ───────── 熔断 ─────────
function noteResult(err) {
  const c = getChatgptWeb();
  if (!err) { if (c.consecutive_failures) setChatgptWeb({ consecutive_failures: 0 }); return; }
  if (!COUNTED.has(err.code)) return;
  const n = c.consecutive_failures + 1;
  setChatgptWeb(n >= c.trip_after ? { consecutive_failures: n, tripped: true, tripped_reason: `${err.code}: ${err.message}` } : { consecutive_failures: n });
}

/** 健康检查：会话已配置且能读到、登录态可用、页面是否打开（不发送任何内容） */
export async function check({ api, bridge: injected } = {}) {
  try {
    const sess = sessionConfig();
    const get = api ?? await conversationApi();
    const conv = await get(sess.conversation_id); assertUsable(conv, sess);
    let tab_open = null, bridge_ok = null;
    const bridge = injected ?? await openBridge().catch(() => null);
    bridge_ok = !!bridge;
    if (bridge) { try { tab_open = !!pickSessionTab((await bridge.call('browser_list_tabs', sess.browser ? { browser: sess.browser } : {})).tabs ?? [], sess.conversation_id); } catch { tab_open = null; } finally { if (!injected) await bridge.close(); } }
    return { ok: true, conversation_id: sess.conversation_id, project_id: sess.project_id, title: conv.title, default_model: conv.default_model_slug, bridge_ok, tab_open };
  } catch (e) { const w = wrap(e); return { ok: false, code: w.code ?? 'error', message: w.message }; }
}

/** 设置固定会话：解析网址并当场验证（能读到、没归档、项目一致）才保存 */
export async function setSession(url, { api } = {}) {
  const p = parseSessionUrl(url);
  if (!p) throw E('chatgpt_web_bad_url', 'expected https://chatgpt.com/c/<id> or https://chatgpt.com/g/g-p-<project>-<name>/c/<id>');
  const get = api ?? await conversationApi();
  const conv = await get(p.conversation_id).catch((e) => { throw wrap(e); });
  assertUsable(conv, p);
  setChatgptWeb({ session_url: String(url).trim(), conversation_id: p.conversation_id, project_id: p.project_id ?? conv.gizmo_id ?? null });
  return { conversation_id: p.conversation_id, project_id: p.project_id ?? conv.gizmo_id ?? null, title: conv.title };
}

export async function webSearch(a, { force = false, api, bridge: injected, pollMs = 2000, sendWaitMs = 25_000, settlePolls = 3 } = {}) {
  const cfg = getChatgptWeb();
  if (!force && !cfg.enabled) return { ok: false, backend: 'chatgpt_web', code: 'chatgpt_web_disabled', message: 'ChatGPT web-session search is switched off (enable: node server/bin/subpow.mjs web on).' };
  if (!force && cfg.tripped) return { ok: false, backend: 'chatgpt_web', code: 'chatgpt_web_disabled', message: `ChatGPT web-session search was auto-disabled (${cfg.tripped_reason}). Fix it, then run: node server/bin/subpow.mjs web reset.` };
  const mode = a.mode ?? 'quick';
  return serial('chatgpt_web', () => withLock('chatgpt-web', cfg.min_interval_ms, async (lock_wait_ms) => {
    const t0 = Date.now(); let bridge = injected;
    try {
      const sess = sessionConfig();
      const get = api ?? await conversationApi();
      assertUsable(await get(sess.conversation_id), sess);
      bridge ??= await openBridge().catch((e) => { throw wrap(e); });
      const b = sess.browser ? { browser: sess.browser } : {};
      const tab = pickSessionTab((await bridge.call('browser_list_tabs', b).catch((e) => { throw wrap(e); })).tabs ?? [], sess.conversation_id);
      if (!tab) throw E('chatgpt_web_no_tab', 'the session page is not open in Chrome — open the configured ChatGPT conversation in a tab (keep it visible) and try again');
      const marker = `[[END:${randomBytes(3).toString('hex')}]]`;
      const n = a.max_results ?? (mode === 'quick' ? 10 : 5);
      const timeoutMs = a.timeout_ms ?? (mode === 'deep' ? 240_000 : cfg.timeout_ms);
      const sent = await typeAndSend(bridge, tab, buildPrompt(mode, a, n, marker), sess.browser).catch((e) => { throw wrap(e); });
      // 轮询会话：先等“我这条”出现（确认真的发出去了），再等这一轮结束
      let turn = null, sig = '', stable = 0; const tSend = Date.now();
      for (;;) {
        await sleep(pollMs);
        turn = readTurn((await get(sess.conversation_id)).mapping, marker);
        if (turn?.done) {
          const now = `${turn.text}|${turn.entries.length}`; stable = now === sig ? stable + 1 : 0; sig = now;
          if (turn.hasMarker || stable >= settlePolls) break;     // 没带标记（模型没照做）就等内容连续不变
        }
        if (!turn && Date.now() - tSend > sendWaitMs) {
          await discardDraft(bridge, tab, sess.browser);
          throw E('chatgpt_web_send_failed', `the message did not appear in the conversation within ${Math.round(sendWaitMs / 1000)}s${sent.visibility === 'hidden' ? ' (the tab is in the background — keep the session page visible)' : ''}`);
        }
        if (Date.now() - t0 > timeoutMs) {
          if (turn?.entries.length && mode === 'quick') { turn.partial = true; break; }
          throw E('chatgpt_web_timeout', `the conversation did not finish within ${Math.round(timeoutMs / 1000)}s`);
        }
      }
      if (!turn.searched) throw E('chatgpt_web_no_search', 'the model answered without searching the web');
      const warnings = turn.partial ? ['timed out before the turn finished; results may be incomplete'] : undefined;
      let body;
      if (mode === 'quick') {
        const results = toResults(turn.entries, n);
        if (!results.length) throw E('chatgpt_web_bad_output', 'the search produced no source entries');
        body = { results };
      } else {
        const answer = turn.text;
        const urls = [...new Set([...toResults(turn.entries, 50).map((r) => r.url), ...extractLinks(answer).map((l) => l.url)])];
        if (!answer) throw E('chatgpt_web_bad_output', 'the model produced no answer text');
        body = { answer, sources: urls.slice(0, n) };
      }
      noteResult(null);
      return { ok: true, backend: 'chatgpt_web', mode, ...body, model: turn.model ?? undefined, warnings, lock_wait_ms, elapsed_ms: Date.now() - t0 };
    } catch (e0) {
      const e = wrap(e0);
      if (!(e instanceof ChatgptWebError)) throw e;
      noteResult(e);
      return { ok: false, backend: 'chatgpt_web', mode, code: e.code, message: e.message, lock_wait_ms, elapsed_ms: Date.now() - t0 };
    } finally { if (!injected && bridge) await bridge.close(); }
  }, (code, message) => E('chatgpt_web_busy', message)));
}
