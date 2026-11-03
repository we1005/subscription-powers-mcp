import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { DIR, CRED_FILE, readJson, writeJson, getDot, setDot } from './store.mjs';
import { serial } from './queue.mjs';
import { withLock as lock } from './lock.mjs';
import { cleanUrl, extractLinks } from './links.mjs';
export { cleanUrl, extractLinks };

/**
 * ChatGPT Pro「Dot」后端：直接调用网页用的 messaging 接口（无官方文档，实测于 2026-11）。
 * 登录态（Bearer + Cookie）来自用户自己的浏览器，保存在 ~/.subscription-powers/dot-credentials.json（0600）。
 * 整个账号只有一个 Dot 房间 → 搜索请求都会进同一个对话，所以用随机结束标记对应请求，并跨进程串行。
 */
const ORIGIN = 'https://chatgpt.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchT = (url, opt, ms = 30_000) => fetch(url, { ...opt, signal: AbortSignal.timeout(ms) });

export class DotError extends Error { constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); } }
// 计入熔断的失败：登录态失效 / 被 Cloudflare 拦 / 房间不存在。网络抖动、限流、超时不计
const COUNTED = new Set(['dot_unavailable', 'dot_blocked']);

// ───────── 纯函数（有单测）─────────
export const parseCookie = (s) => Object.fromEntries(s.split(/;\s*/).filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
export const serializeCookie = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('; ');
/** 把响应里的 Set-Cookie 合并进 Cookie 串（服务器会轮换 session-token；过期/空值表示删除） */
export function mergeSetCookie(cookie, setCookies) {
  const jar = parseCookie(cookie);
  for (const sc of setCookies) {
    const [nv, ...attrs] = sc.split(';'); const i = nv.indexOf('=');
    if (i < 1) continue;
    const name = nv.slice(0, i).trim(), val = nv.slice(i + 1);
    if (val === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) delete jar[name]; else jar[name] = val;
  }
  return serializeCookie(jar);
}
export const jwtExp = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).exp * 1000; } catch { return 0; } };
/** 房间里排在我这条消息之后、不是我发的消息 = Dot 的回复（role 两边都是 user，只能靠 account_user_id 区分） */
export function pickReplies(items, mine) {
  return items.filter((m) => !m.deleted_at && m.id !== mine.id && m.created_at > mine.created_at && m.account_user_id !== mine.account_user_id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
const stripMarker = (t, marker) => t.split(marker).join('').replace(/\n{3,}/g, '\n\n').trim();
/** quick 模式：优先解析 ```json 块，失败则退化为文中的链接 */
export function parseQuick(text, n) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let arr;
  try { const j = JSON.parse((fence ? fence[1] : text).trim()); arr = Array.isArray(j) ? j : j.results; } catch {}
  let out = (arr ?? []).filter((x) => x && /^https?:\/\//i.test(x.url ?? '')).map((x) => ({ title: String(x.title ?? x.url).trim(), url: cleanUrl(x.url), summary: String(x.summary ?? '').trim() }));
  if (!out.length) out = extractLinks(text).map((l) => ({ ...l, summary: '' }));
  const seen = new Set();
  return out.filter((x) => !seen.has(x.url) && seen.add(x.url)).slice(0, n);
}
export function buildPrompt(mode, a, n, marker) {
  const rules = 'Do NOT use your computer, plugins, Slack, scheduled tasks, files, or memory. Do not save or remember anything. Do not ask me questions.';
  const recency = a.recency ? `Prefer results from the last ${a.recency}.\n` : '';
  if (mode === 'quick') return `[API call — web search backend] Follow these rules exactly:
1. Use ONLY your built-in web search. One search is enough (a second only if the first found nothing relevant).
2. ${rules}
3. Query: ${a.query.trim()}
${recency}Reply with ONLY one fenced json code block: {"results":[{"title":"page title","url":"https://full-url","summary":"one sentence, in the query's language, saying what the page says"}]} with up to ${n} distinct relevant results (prefer different sites). No other text. Then on its own last line write exactly: ${marker}`;
  return `[API call — web research backend] Follow these rules exactly:
1. Use ONLY your built-in web search. Do up to ${Math.max(2, Math.ceil(n / 2))} searches and cross-check the sources.
2. ${rules}
3. Question: ${a.query.trim()}
${recency}Reply in the question's language: a concise, factual answer, then a "Sources" list of markdown links with full URLs (up to ${n}). Then on its own last line write exactly: ${marker}`;
}

// ───────── 客户端 ─────────
const snippet = (t) => t.replace(/\s+/g, ' ').slice(0, 200);
function classifyHttp(r, text) {
  if (r.headers.get('cf-mitigated') === 'challenge' || /^\s*<(!doctype|html)/i.test(text)) return new DotError('dot_blocked', `Cloudflare challenge (HTTP ${r.status}); stored browser cookies no longer pass — re-import credentials`);
  if (r.status === 401 || r.status === 403) return new DotError('dot_unavailable', `HTTP ${r.status}: ${snippet(text)}`);
  if (r.status === 404) return new DotError('dot_unavailable', 'HTTP 404 (Dot room not found — subscription lapsed or Dot deleted?)');
  if (r.status === 429) return new DotError('dot_rate_limited', `HTTP 429: ${snippet(text)}`);
  return new DotError('dot_network', `HTTP ${r.status}: ${snippet(text)}`);
}

export class Dot {
  load() {
    const c = readJson(CRED_FILE, null);
    if (!c?.cookie || !c?.room_id || !c?.access_token) throw new DotError('dot_no_credentials', `no Dot credentials at ${CRED_FILE} — run: node server/bin/subpow.mjs dot capture (or dot import-har <file>)`);
    return (this.cred = c);
  }
  save() { if (!this.readOnly) writeJson(CRED_FILE, this.cred); }   // readOnly：试运行/验证时不落盘
  headers(extra = {}) {
    const c = this.cred;
    return { ...c.static_headers, authorization: `Bearer ${c.access_token}`, 'chatgpt-account-id': c.account_id, 'oai-device-id': c.device_id, 'oai-did': c.device_id, cookie: c.cookie, referer: `${ORIGIN}/`, origin: ORIGIN, accept: '*/*', ...extra };
  }
  /** 用会话 Cookie 换 access token，并保存被轮换的 Cookie */
  async refresh() {
    const c = this.cred; let r, j;
    try {
      r = await fetchT(`${ORIGIN}/api/auth/session`, { headers: { ...c.static_headers, cookie: c.cookie, referer: `${ORIGIN}/`, accept: '*/*' } });
      const sc = r.headers.getSetCookie?.() ?? [];
      if (sc.length) c.cookie = mergeSetCookie(c.cookie, sc);
      j = await r.json().catch(() => ({}));
    } catch (e) { throw new DotError('dot_network', `session refresh failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`); }
    if (!r.ok || !j.accessToken) { if (r.headers.get('cf-mitigated') === 'challenge') throw classifyHttp(r, ''); throw new DotError('dot_unavailable', 'session expired or logged out (no accessToken) — log in to chatgpt.com and re-import credentials'); }
    c.access_token = j.accessToken; c.session_expires = j.expires ?? c.session_expires; c.refreshed_at = new Date().toISOString();
    this.save();
    return { token_expires: new Date(jwtExp(j.accessToken)).toISOString(), session_expires: j.expires };
  }
  async ensureToken() {
    if (jwtExp(this.cred.access_token) - Date.now() > 24 * 3600_000) return;
    try { await this.refresh(); } catch (e) { if (jwtExp(this.cred.access_token) < Date.now() + 60_000) throw e; /* 旧令牌还没过期就继续用 */ }
  }
  async api(method, p, body) {
    for (let attempt = 0; ; attempt++) {
      await this.ensureToken();
      let r, text;
      try { r = await fetchT(ORIGIN + p, { method, headers: this.headers(body ? { 'content-type': 'application/json', 'oai-telemetry': '[1,null]' } : {}), body: body && JSON.stringify(body) }); text = await r.text(); }
      catch (e) { throw new DotError('dot_network', e.name === 'TimeoutError' ? 'request timed out' : `${e.cause?.code ?? e.message}`); }
      if (r.status === 401 && attempt === 0) { await this.refresh(); continue; }
      if (!r.ok) throw classifyHttp(r, text);
      try { return JSON.parse(text); } catch { throw new DotError('dot_bad_output', 'non-JSON response from Dot API'); }
    }
  }
  send(text) {
    return this.api('POST', `/backend-api/messaging/rooms/${this.cred.room_id}/messages`, { content: { text }, request_id: randomUUID(), page_context: { page_id: null }, idempotency_token: randomUUID(), timezone_offset_min: new Date().getTimezoneOffset() });
  }
  async list(limit = 30) { return (await this.api('GET', `/backend-api/messaging/rooms/${this.cred.room_id}/messages?limit=${limit}`)).items ?? []; }
  /** 轮询直到 Dot 的回复里出现结束标记；没标记但回复已稳定 settleMs 也算结束（带警告） */
  async waitReply(mine, marker, { timeoutMs, settleMs = 15_000, intervalMs = 1500 }) {
    const t0 = Date.now(); let seen = '', changedAt = Date.now();
    for (;;) {
      const replies = pickReplies(await this.list(30), mine);
      const texts = replies.map((m) => m.content?.text ?? '');
      const joined = texts.join('\n\n');
      if (joined !== seen) { seen = joined; changedAt = Date.now(); }
      const final = texts.findIndex((t) => t.includes(marker));
      if (final >= 0) return { text: stripMarker(texts[final], marker), complete: true, replies: replies.length };
      const direct = replies.filter((m) => m.message_metadata?.turn_trigger === 'chatgpt_messaging').map((m) => m.content?.text ?? '');
      if (direct.length && Date.now() - changedAt > settleMs) return { text: stripMarker(direct.join('\n\n'), marker), complete: false, replies: replies.length };
      if (Date.now() - t0 > timeoutMs) {
        if (direct.length) return { text: stripMarker(direct.join('\n\n'), marker), complete: false, timedOut: true, replies: replies.length };
        throw new DotError('dot_timeout', `no reply from Dot within ${Math.round(timeoutMs / 1000)}s`);
      }
      await sleep(intervalMs);
    }
  }
}

/** 健康检查：续期令牌 + 读一条消息，不发送任何内容 */
export async function check() {
  try {
    const d = new Dot(); d.load();
    const s = await d.refresh();
    await d.list(1);
    return { ok: true, ...s, captured_at: d.cred.captured_at };
  } catch (e) { return { ok: false, code: e.code ?? 'error', message: e.message }; }
}

/** 从浏览器请求头（键名小写）构造登录态。HAR 导入和 bridge 自动抓取共用，不打印任何机密 */
const STATIC_KEYS = ['originator', 'x-openai-codex-window-type', 'x-openai-rate-limit-join-workspace', 'x-openai-web-frontend', 'oai-language', 'oai-client-version', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-language'];
export function buildCred(H, roomId, extra = {}) {
  const cred = { captured_at: new Date().toISOString(), room_id: roomId, account_id: H['chatgpt-account-id'], device_id: H['oai-device-id'] ?? H['oai-did'], access_token: (H.authorization ?? '').split(' ', 2)[1], cookie: H.cookie, static_headers: Object.fromEntries(STATIC_KEYS.filter((k) => H[k]).map((k) => [k, H[k]])), ...extra };
  if (!cred.cookie || !cred.account_id || !cred.access_token) throw new DotError('dot_no_credentials', 'request lacks authorization / cookie / chatgpt-account-id');
  if (!cred.room_id) throw new DotError('dot_no_credentials', 'no Dot room id found — send one message in the Dot page while capturing');
  return cred;
}
export const credSummary = (cred) => ({ file: CRED_FILE, room_id: cred.room_id, token_expires: new Date(jwtExp(cred.access_token)).toISOString(), cookies: Object.keys(parseCookie(cred.cookie)).length });

/** 从 chrome-agent-bridge 导出的 HAR 里提取登录态 */
export function importHar(file) {
  const es = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries;
  const hdrs = (e) => Object.fromEntries(e.request.headers.filter((h) => !h.name.startsWith(':')).map((h) => [h.name.toLowerCase(), h.value]));
  const isRoom = (e) => /\/messaging\/rooms\/[0-9a-f]{32}/.test(e.request.url);
  const e = es.find((x) => x.request.method === 'POST' && /\/rooms\/[0-9a-f]{32}\/messages$/.test(x.request.url.split('?')[0]) && hdrs(x).authorization) ?? es.find((x) => isRoom(x) && hdrs(x).authorization);
  if (!e) throw new DotError('dot_no_credentials', 'HAR has no authenticated /messaging/rooms request — send one message in the Dot page while capturing');
  const cred = buildCred(hdrs(e), e.request.url.match(/\/rooms\/([0-9a-f]{32})/)[1]);
  writeJson(CRED_FILE, cred);
  return credSummary(cred);
}

// ───────── 跨进程串行 + 熔断 ─────────
// 每个 Claude Code / mirasim 会话都有自己的 MCP 进程，但 Dot 房间只有一个：用锁文件保证同一时刻只有一个请求在房间里
const withLock = (minGapMs, fn) => lock('dot', minGapMs, fn, (code, msg) => new DotError(code, msg));
function noteResult(err) {
  const c = getDot();
  if (!err) { if (c.consecutive_failures) setDot({ consecutive_failures: 0 }); return; }
  if (!COUNTED.has(err.code)) return;
  const n = c.consecutive_failures + 1;
  setDot(n >= c.trip_after ? { consecutive_failures: n, tripped: true, tripped_reason: `${err.code}: ${err.message}` } : { consecutive_failures: n });
}

export async function webSearch(a, { force = false } = {}) {
  const cfg = getDot();
  if (!force && !cfg.enabled) return { ok: false, backend: 'dot', code: 'dot_disabled', message: 'Dot search backend is switched off (enable: node server/bin/subpow.mjs dot on). Use codex_web_search instead.' };
  if (!force && cfg.tripped) return { ok: false, backend: 'dot', code: 'dot_disabled', message: `Dot search backend was auto-disabled (${cfg.tripped_reason}). Fix it, then run: node server/bin/subpow.mjs dot reset. Use codex_web_search instead.` };
  const mode = a.mode ?? 'quick';
  return serial('dot', () => withLock(cfg.min_interval_ms, async (lock_wait_ms) => {
    const t0 = Date.now();
    const attempt = async () => {
      const d = new Dot(); d.load();
      const nonce = randomBytes(3).toString('hex'), marker = `[[END:${nonce}]]`;
      const n = a.max_results ?? (mode === 'quick' ? 10 : 5);
      const mine = await d.send(buildPrompt(mode, a, n, marker));
      const got = await d.waitReply(mine, marker, { timeoutMs: a.timeout_ms ?? (mode === 'deep' ? 240_000 : cfg.timeout_ms) });
      const warnings = got.complete ? undefined : [got.timedOut ? 'timed out before the end marker; reply may be partial' : 'reply had no end marker; may be partial'];
      let body;
      if (mode === 'quick') {
        const results = parseQuick(got.text, n);
        if (!results.length) throw new DotError('dot_bad_output', `could not find any results in Dot's reply: ${snippet(got.text)}`);
        body = { results };
      } else body = { answer: got.text, sources: extractLinks(got.text).map((l) => l.url).slice(0, n) };
      return { ok: true, backend: 'dot', mode, ...body, warnings, dot_messages: got.replies };
    };
    let recapture;
    try {
      let out;
      try { out = await attempt(); }
      catch (e) {
        // 登录态失效 → 若开启了自动重抓，从日常 Chrome 取新登录态后重试一次（有冷却，避免反复附加调试器）
        const cap = await import('./dot-capture.mjs');
        if (!(e instanceof DotError) || !cap.shouldRecapture(getDot(), e.code)) throw e;
        recapture = await cap.autoRecapture();
        if (!recapture.ok) throw e;
        out = await attempt();
      }
      noteResult(null);
      return { ...out, ...(recapture ? { recaptured: true } : {}), lock_wait_ms, elapsed_ms: Date.now() - t0 };
    } catch (e) {
      if (!(e instanceof DotError)) throw e;
      noteResult(e);
      return { ok: false, backend: 'dot', mode, code: e.code, message: e.message, ...(recapture ? { recapture: { ok: recapture.ok, code: recapture.code, message: recapture.message } } : {}), lock_wait_ms, elapsed_ms: Date.now() - t0 };
    }
  }));
}
