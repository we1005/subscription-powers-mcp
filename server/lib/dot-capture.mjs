import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CRED_FILE, readJson, writeJson, getDot, setDot } from './store.mjs';
import { Dot, DotError, buildCred, credSummary } from './dot.mjs';

/**
 * 路线 3：借日常 Chrome 里已登录的 Dot 标签页，经 chrome-agent-bridge 自动抓取登录态。
 *   1. 找到 chatgpt.com/dots 标签页 → 附加调试器（CDP）→ 只监听网络事件，不刷新、不发消息
 *   2. 页面自己会定期发带令牌的请求（wham/usage 等），从中读出 Bearer / Cookie / 设备号 / 前端版本
 *   3. 立刻分离调试器；用抓到的登录态只读验证一次，通过才写入 dot-credentials.json
 * 原始 CDP 事件含机密，只在本进程内处理，绝不经过模型对话、不打印、不落盘（除最终的 0600 凭据文件）。
 */
export const bridgeServer = () => process.env.SUBPOW_BRIDGE_SERVER || path.join(os.homedir(), '.local', 'share', 'chrome-agent-bridge', 'mcp', 'server.mjs');
const DOT_TAB = /^https:\/\/chatgpt\.com\/dots(\/|\?|#|$)/;
const ROOM_RE = /\/messaging\/rooms\/([0-9a-f]{32})/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── 纯函数（有单测）─────────
export const pickDotTab = (tabs) => tabs.find((t) => DOT_TAB.test(t.url ?? '')) ?? null;
const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
/** 把 Network.requestWillBeSent（URL、大部分头）和 requestWillBeSentExtraInfo（Cookie 等浏览器后加的头）按 requestId 合并 */
export function mergeRequests(events) {
  const by = new Map();
  for (const e of events) {
    const id = e.params?.requestId;
    if (!id) continue;
    if (e.method === 'Network.requestWillBeSent') { const r = by.get(id) ?? { headers: {} }; by.set(id, { ...r, url: e.params.request?.url, method: e.params.request?.method, headers: { ...r.headers, ...lower(e.params.request?.headers) } }); }
    else if (e.method === 'Network.requestWillBeSentExtraInfo') { const r = by.get(id) ?? { headers: {} }; r.headers = { ...r.headers, ...lower(e.params.headers) }; by.set(id, r); }
  }
  return [...by.values()].filter((r) => r.url);
}
/** 第一个带全登录信息的 chatgpt.com 后端请求；没有则 null */
export const pickAuthed = (reqs) => reqs.find((r) => /^https:\/\/chatgpt\.com\/backend-api\//.test(r.url) && /^Bearer \S+/.test(r.headers.authorization ?? '') && r.headers.cookie && r.headers['chatgpt-account-id']) ?? null;
export const findRoomId = (reqs) => { for (const r of reqs) { const m = r.url.match(ROOM_RE); if (m) return m[1]; } return null; };
/** 自动重抓的触发条件：只对登录态类失败、已开启、过了冷却期 */
export function shouldRecapture(cfg, code, now = Date.now()) {
  if (!cfg.auto_recapture || !['dot_unavailable', 'dot_blocked'].includes(code)) return false;
  return !cfg.last_recapture_at || now - Date.parse(cfg.last_recapture_at) >= cfg.recapture_cooldown_ms;
}

// ───────── bridge 适配 ─────────
export async function openBridge() {
  const file = bridgeServer();
  if (!fs.existsSync(file)) throw new DotError('dot_capture_no_bridge', `chrome-agent-bridge not found at ${file} (set SUBPOW_BRIDGE_SERVER to its mcp/server.mjs)`);
  const client = new Client({ name: 'subscription-powers-capture', version: '1.0.0' });
  try { await client.connect(new StdioClientTransport({ command: process.execPath, args: [file], stderr: 'ignore' })); }
  catch (e) { throw new DotError('dot_capture_no_bridge', `cannot start chrome-agent-bridge: ${e.message}`); }
  return {
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.[0]?.text ?? '';
      let j; try { j = JSON.parse(text); } catch { j = { _raw: text.slice(0, 200) }; }
      if (r.isError) throw new DotError('dot_capture_bridge', `${name}: ${String(j.error?.message ?? j.message ?? j._raw ?? 'failed').slice(0, 200)}`);
      return j;
    },
    close: () => client.close().catch(() => {}),
  };
}

/**
 * 从浏览器取登录态。bridge 可注入（测试用假的）。
 * open：没有 Dot 标签页时，用上次记住的 dot_url 新开一个后台标签页。
 */
export async function captureFromBrowser({ bridge, open = false, browser, timeoutMs = 25_000, pollMs = 4000 }) {
  const b = browser ? { browser } : {};
  let tab = pickDotTab((await bridge.call('browser_list_tabs', b)).tabs ?? []);
  let opened = false;
  if (!tab && open) {
    const url = getDot().dot_url;
    if (!url) throw new DotError('dot_capture_no_tab', 'no Dot tab is open and no dot_url is remembered yet — open the Dot page in Chrome once');
    const o = await bridge.call('browser_open_tab', { url, active: false, ...b });
    opened = o.tabId ?? o.tab?.id ?? true;
    await sleep(6000);
    tab = pickDotTab((await bridge.call('browser_list_tabs', b)).tabs ?? []);
  }
  if (!tab) throw new DotError('dot_capture_no_tab', 'no chatgpt.com/dots tab found in Chrome — open your Dot chat in Chrome (logged in), or pass --open');
  const att = await bridge.call('browser_cdp_attach', { tabId: tab.id, captureEvents: true, maxEvents: 1000, maxBytes: 8_388_608, leaseTtlMs: 90_000, ownerLabel: 'subscription-powers dot capture', ...b });
  const sid = att.sessionId;
  try {
    await bridge.call('browser_cdp_send', { sessionId: sid, method: 'Network.enable', params: {} });
    const events = []; let cursor = 0; const t0 = Date.now(); let reqs, picked = null;
    for (;;) {
      const ev = await bridge.call('browser_cdp_events', { sessionId: sid, afterCursor: cursor, limit: 200, timeoutMs: Math.min(pollMs, Math.max(500, timeoutMs - (Date.now() - t0))) });
      for (const e of ev.events ?? []) events.push(e);
      cursor = ev.cursor ?? ev.latestCursor ?? cursor;
      reqs = mergeRequests(events); picked = pickAuthed(reqs);
      if (picked || Date.now() - t0 >= timeoutMs) break;
    }
    if (!picked) throw new DotError('dot_capture_no_auth', `no authenticated chatgpt.com request seen within ${Math.round(timeoutMs / 1000)}s — is the Dot tab logged in? (the page only talks now and then; try again, or interact with the tab)`);
    const H = { ...picked.headers };
    if (!H['oai-client-version']) {
      const v = (await bridge.call('browser_cdp_send', { sessionId: sid, method: 'Runtime.evaluate', params: { expression: "document.documentElement.getAttribute('data-build')", returnByValue: true } }).catch(() => ({})))?.result?.result?.value;
      if (typeof v === 'string' && /^[\w.-]{6,64}$/.test(v)) H['oai-client-version'] = v;
    }
    return { headers: H, roomId: findRoomId(reqs), tab: { id: tab.id, url: tab.url.split(/[?#]/)[0] }, opened, events: events.length };
  } finally {
    await bridge.call('browser_cdp_detach', { sessionId: sid }).catch(() => {});
    if (opened && typeof opened !== 'boolean') await bridge.call('browser_close_tab', { tabId: opened, ...b }).catch(() => {});
  }
}

/** 房间 id 兜底：现有凭据里的 → 房间列表接口（未文档化，尽力而为） */
async function discoverRoom(d) {
  try {
    const j = await d.api('GET', '/backend-api/messaging/rooms');
    const list = Array.isArray(j) ? j : j.items ?? j.rooms ?? [];
    const id = list.map((x) => x.id ?? x.room_id).find((x) => /^[0-9a-f]{32}$/.test(x ?? ''));
    if (id) return id;
  } catch {}
  return null;
}

/**
 * 完整流程：抓取 → 只读验证 → 保存。dryRun 只验证、不写文件。
 * 返回里不含任何令牌 / Cookie 值。
 */
export async function capture({ dryRun = false, open = false, browser, timeoutMs, bridge: injected } = {}) {
  const bridge = injected ?? await openBridge();
  let got;
  try { got = await captureFromBrowser({ bridge, open, browser, timeoutMs }); }
  finally { if (!injected) await bridge.close(); }
  const old = readJson(CRED_FILE, null);
  const d = new Dot(); d.readOnly = true;
  d.cred = buildCred(got.headers, got.roomId ?? old?.room_id ?? 'pending', { session_expires: old?.session_expires });
  let roomId = got.roomId ?? old?.room_id ?? null;
  let roomFrom = got.roomId ? 'browser traffic' : old?.room_id ? 'previous credentials' : null;
  if (!roomId) { roomId = await discoverRoom(d); roomFrom = roomId ? 'rooms API' : null; }
  if (!roomId) throw new DotError('dot_capture_no_room', 'logged in, but could not determine the Dot room id — send one message in the Dot page while running capture');
  d.cred.room_id = roomId;
  try { await d.list(1); }
  catch (e) { throw new DotError('dot_capture_verify_failed', `captured credentials did not pass verification (${e.code}: ${e.message}); nothing was saved`); }
  if (!dryRun) { d.readOnly = false; d.save(); setDot({ dot_url: got.tab.url, ...(getDot().tripped && /^dot_(unavailable|blocked)/.test(getDot().tripped_reason ?? '') ? { tripped: false, tripped_reason: null, consecutive_failures: 0 } : {}) }); }
  return { ok: true, dry_run: dryRun, saved: !dryRun, tab: got.tab, room_id: roomId, room_from: roomFrom, events_seen: got.events, token_expires: new Date(JSON.parse(Buffer.from(d.cred.access_token.split('.')[1], 'base64url')).exp * 1000).toISOString(), ...(dryRun ? {} : credSummary(d.cred)) };
}

/** 自动重抓入口：带冷却记录；失败只返回原因，不抛 */
export async function autoRecapture() {
  setDot({ last_recapture_at: new Date().toISOString() });
  try { return await capture({}); } catch (e) { return { ok: false, code: e.code ?? 'error', message: e.message }; }
}
