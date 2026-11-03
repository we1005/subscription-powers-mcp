// 路线 3（bridge 自动抓取登录态）的测试：纯解析 + 假 bridge，不联网、不碰真实浏览器和凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SUBPOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'subpow-cap-'));
const cap = await import('../lib/dot-capture.mjs');
const dot = await import('../lib/dot.mjs');

const ROOM = 'a'.repeat(32);
const sent = (requestId, url, headers = {}) => ({ method: 'Network.requestWillBeSent', params: { requestId, request: { url, method: 'GET', headers } } });
const extra = (requestId, headers) => ({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId, headers } });
const authed = (id, url = 'https://chatgpt.com/backend-api/wham/usage') => [
  sent(id, url, { Authorization: 'Bearer tok.en.x', 'ChatGPT-Account-Id': 'acc-1', 'OAI-Device-Id': 'dev-1', 'User-Agent': 'UA' }),
  extra(id, { cookie: 'a=1; b=2' }),
];

test('pickDotTab：只认 chatgpt.com/dots 标签页', () => {
  const tabs = [{ id: 1, url: 'https://chatgpt.com/c/123' }, { id: 2, url: 'https://evilchatgpt.com/dots/x' }, { id: 3, url: 'https://chatgpt.com/dots/u~v' }];
  assert.equal(cap.pickDotTab(tabs).id, 3);
  assert.equal(cap.pickDotTab(tabs.slice(0, 2)), null);
});

test('mergeRequests / pickAuthed：把 URL、头和 ExtraInfo 里的 Cookie 按 requestId 合并', () => {
  const reqs = cap.mergeRequests([sent('r0', 'https://chatgpt.com/backend-api/x', { 'X-A': '1' }), ...authed('r1')]);
  assert.equal(reqs.length, 2);
  const got = cap.pickAuthed(reqs);
  assert.equal(got.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(got.headers.cookie, 'a=1; b=2');            // 来自 ExtraInfo
  assert.equal(got.headers['chatgpt-account-id'], 'acc-1'); // 头名统一小写
});

test('pickAuthed：缺 Cookie、缺账号、非 backend-api、非 Bearer 的请求都不算', () => {
  const evs = [
    sent('a', 'https://chatgpt.com/backend-api/x', { authorization: 'Bearer t', 'chatgpt-account-id': 'x' }),                      // 无 cookie
    ...[sent('b', 'https://chatgpt.com/backend-api/x', { authorization: 'Bearer t' }), extra('b', { cookie: 'c=1' })],            // 无账号
    ...[sent('c', 'https://cdn.chatgpt.com/other', { authorization: 'Bearer t', 'chatgpt-account-id': 'x' }), extra('c', { cookie: 'c=1' })],
    ...[sent('d', 'https://chatgpt.com/backend-api/x', { authorization: 'Basic t', 'chatgpt-account-id': 'x' }), extra('d', { cookie: 'c=1' })],
  ];
  assert.equal(cap.pickAuthed(cap.mergeRequests(evs)), null);
});

test('findRoomId：从任意 /messaging/rooms/<id> 请求里取房间号', () => {
  assert.equal(cap.findRoomId(cap.mergeRequests([sent('a', 'https://chatgpt.com/backend-api/x'), sent('b', `https://chatgpt.com/backend-api/messaging/rooms/${ROOM}/messages?limit=1`)])), ROOM);
  assert.equal(cap.findRoomId(cap.mergeRequests([sent('a', 'https://chatgpt.com/backend-api/x')])), null);
});

test('shouldRecapture：只在开启、登录态类错误、过了冷却期时触发', () => {
  const cfg = { auto_recapture: true, recapture_cooldown_ms: 600_000, last_recapture_at: null };
  const now = Date.parse('2026-11-03T10:00:00Z');
  assert.equal(cap.shouldRecapture(cfg, 'dot_unavailable', now), true);
  assert.equal(cap.shouldRecapture(cfg, 'dot_blocked', now), true);
  assert.equal(cap.shouldRecapture(cfg, 'dot_network', now), false);
  assert.equal(cap.shouldRecapture({ ...cfg, auto_recapture: false }, 'dot_unavailable', now), false);
  assert.equal(cap.shouldRecapture({ ...cfg, last_recapture_at: '2026-11-03T09:55:00Z' }, 'dot_unavailable', now), false);
  assert.equal(cap.shouldRecapture({ ...cfg, last_recapture_at: '2026-11-03T09:49:00Z' }, 'dot_unavailable', now), true);
});

test('buildCred：缺字段报 dot_no_credentials，字段齐全则只保留白名单静态头', () => {
  const H = { authorization: 'Bearer tt', cookie: 'a=1', 'chatgpt-account-id': 'acc', 'oai-device-id': 'dev', 'user-agent': 'UA', 'x-secret-extra': 'nope' };
  const c = dot.buildCred(H, ROOM);
  assert.deepEqual([c.account_id, c.device_id, c.access_token, c.room_id], ['acc', 'dev', 'tt', ROOM]);
  assert.deepEqual(Object.keys(c.static_headers), ['user-agent']);
  assert.throws(() => dot.buildCred({ ...H, cookie: undefined }, ROOM), { code: 'dot_no_credentials' });
  assert.throws(() => dot.buildCred(H, null), { code: 'dot_no_credentials' });
});

/** 假 bridge：记录调用；events 按批次返回 */
function fakeBridge({ tabs, batches, buildAttr = null }) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push(name);
      if (name === 'browser_list_tabs') return { tabs };
      if (name === 'browser_cdp_attach') return { sessionId: 's1' };
      if (name === 'browser_cdp_events') return { events: batches.shift() ?? [], cursor: 1 };
      if (name === 'browser_cdp_send') return args.method === 'Runtime.evaluate' ? { result: { result: { value: buildAttr } } } : {};
      return {};
    },
  };
}
const DOT_TAB = { id: 7, url: 'https://chatgpt.com/dots/u~v?x=1' };

test('captureFromBrowser：抓到登录态，补上页面的前端版本，并且一定分离调试器', async () => {
  const b = fakeBridge({ tabs: [DOT_TAB], batches: [[], authed('r1', `https://chatgpt.com/backend-api/messaging/rooms/${ROOM}/messages`)], buildAttr: 'abc123def456' });
  const r = await cap.captureFromBrowser({ bridge: b, timeoutMs: 5000, pollMs: 50 });
  assert.equal(r.roomId, ROOM);
  assert.equal(r.headers['oai-client-version'], 'abc123def456');
  assert.equal(r.tab.url, 'https://chatgpt.com/dots/u~v');   // 地址里的 query 被去掉
  assert.equal(b.calls.at(-1), 'browser_cdp_detach');
});

test('captureFromBrowser：超时没看到带登录的请求 → dot_capture_no_auth，仍然分离调试器', async () => {
  const b = fakeBridge({ tabs: [DOT_TAB], batches: [] });
  await assert.rejects(cap.captureFromBrowser({ bridge: b, timeoutMs: 150, pollMs: 50 }), { code: 'dot_capture_no_auth' });
  assert.equal(b.calls.at(-1), 'browser_cdp_detach');
});

test('captureFromBrowser：没有 Dot 标签页 → dot_capture_no_tab，不会附加任何调试器', async () => {
  const b = fakeBridge({ tabs: [{ id: 1, url: 'https://chatgpt.com/c/1' }], batches: [] });
  await assert.rejects(cap.captureFromBrowser({ bridge: b }), { code: 'dot_capture_no_tab' });
  assert.ok(!b.calls.includes('browser_cdp_attach'));
});
