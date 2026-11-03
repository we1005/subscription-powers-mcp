// Dot 后端的纯函数与开关逻辑测试：不联网、不碰真实凭据（SUBPOW_HOME 指向临时目录）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subpow-test-'));
process.env.SUBPOW_HOME = home;
const store = await import('../lib/store.mjs');
const dot = await import('../lib/dot.mjs');

test('mergeSetCookie：更新、新增、按 max-age=0 / 空值删除', () => {
  const out = dot.mergeSetCookie('a=1; b=2; c=3', ['a=9; Path=/; Secure', 'd=4; HttpOnly', 'b=; Path=/', 'c=x; Max-Age=0']);
  assert.deepEqual(dot.parseCookie(out), { a: '9', d: '4' });
  // 值里带 = 的 Cookie（base64）不能被截断
  assert.equal(dot.parseCookie(dot.mergeSetCookie('', ['t=abc==; Path=/'])).t, 'abc==');
});

test('jwtExp：读取过期时间；坏令牌返回 0', () => {
  const tok = `x.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url')}.y`;
  assert.equal(dot.jwtExp(tok), 2000000000 * 1000);
  assert.equal(dot.jwtExp('not-a-jwt'), 0);
});

test('pickReplies：只取我这条之后、非我发出的消息，按时间排序，忽略已删除', () => {
  const mine = { id: 'm', created_at: '2026-11-03T07:42:07.277741Z', account_user_id: 'user-1' };
  const items = [
    { id: 'r2', created_at: '2026-11-03T07:42:20.000000Z', account_user_id: 'calpico-member-x' },
    { id: 'old', created_at: '2026-11-03T07:00:00.000000Z', account_user_id: 'calpico-member-x' },
    { id: 'm', created_at: mine.created_at, account_user_id: 'user-1' },
    { id: 'r1', created_at: '2026-11-03T07:42:09.000000Z', account_user_id: 'calpico-member-x' },
    { id: 'gone', created_at: '2026-11-03T07:42:10.000000Z', account_user_id: 'calpico-member-x', deleted_at: 'x' },
    { id: 'mine2', created_at: '2026-11-03T07:42:11.000000Z', account_user_id: 'user-1' },
  ];
  assert.deepEqual(dot.pickReplies(items, mine).map((m) => m.id), ['r1', 'r2']);
});

test('parseQuick：解析 json 代码块、去掉 utm_source=chatgpt.com、去重、截断', () => {
  const text = '```json\n{"results":[{"title":"A","url":"https://a.com/x?utm_source=chatgpt.com&k=1","summary":"s"},{"title":"A2","url":"https://a.com/x?k=1&utm_source=chatgpt.com","summary":"dup"},{"title":"bad","url":"ftp://x"},{"title":"B","url":"https://b.com","summary":"t"}]}\n```';
  const r = dot.parseQuick(text, 10);
  assert.deepEqual(r.map((x) => x.url), ['https://a.com/x?k=1', 'https://b.com/']);
  assert.equal(dot.parseQuick(text, 1).length, 1);
});

test('parseQuick：没有 JSON 时退化为文中的 markdown 链接', () => {
  const r = dot.parseQuick('见 [官网](https://nodejs.org/en/download) 和 https://github.com/nodejs/node/releases。', 5);
  assert.deepEqual(r.map((x) => x.url), ['https://nodejs.org/en/download', 'https://github.com/nodejs/node/releases']);
  assert.equal(r[0].title, '官网');
});

test('buildPrompt：带结束标记、禁止使用电脑/记忆；quick 要 JSON，deep 要 Sources', () => {
  const q = dot.buildPrompt('quick', { query: 'foo', recency: 'week' }, 7, '[[END:abc123]]');
  assert.match(q, /\[\[END:abc123\]\]/); assert.match(q, /Do NOT use your computer/); assert.match(q, /up to 7/); assert.match(q, /last week/);
  assert.match(dot.buildPrompt('deep', { query: 'foo' }, 5, '[[END:z]]'), /"Sources" list/);
});

test('开关：默认关；on/off/熔断 对 dotActive 的影响', () => {
  assert.equal(store.dotActive(), false);
  store.setDot({ enabled: true });
  assert.equal(store.dotActive(), true);
  store.setDot({ tripped: true, tripped_reason: 'x' });
  assert.equal(store.dotActive(), false);
  store.setDot({ tripped: false, enabled: false });
  assert.equal(store.dotActive(), false);
  assert.equal(fs.statSync(store.CONFIG_FILE).mode & 0o777, 0o600);   // 配置文件仅本人可读写
});

test('webSearch：关闭 / 熔断时直接返回 dot_disabled，不碰网络', async () => {
  store.setDot({ enabled: false, tripped: false });
  assert.equal((await dot.webSearch({ query: 'q' })).code, 'dot_disabled');
  store.setDot({ enabled: true, tripped: true, tripped_reason: 'dot_unavailable: HTTP 401' });
  const r = await dot.webSearch({ query: 'q' });
  assert.equal(r.code, 'dot_disabled'); assert.match(r.message, /auto-disabled/);
});

test('webSearch：开着但没有登录态 → dot_no_credentials，且不计入熔断', async () => {
  store.setDot({ enabled: true, tripped: false, consecutive_failures: 0 });
  const r = await dot.webSearch({ query: 'q' });
  assert.equal(r.code, 'dot_no_credentials');
  assert.equal(store.getDot().consecutive_failures, 0);
});

test('importHar：提取登录态并以 0600 保存；缺少带凭据的请求时报错', () => {
  const room = 'a'.repeat(32);
  const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const har = (entries) => { const f = path.join(home, `t${Math.random()}.har`); fs.writeFileSync(f, JSON.stringify({ log: { entries } })); return f; };
  const good = { request: { method: 'POST', url: `https://chatgpt.com/backend-api/messaging/rooms/${room}/messages`, headers: h({ ':authority': 'x', Authorization: 'Bearer tok.en.x', 'ChatGPT-Account-Id': 'acc', 'OAI-Device-Id': 'dev', cookie: 'a=1; b=2', 'User-Agent': 'UA', 'oai-client-version': 'v1' }) } };
  const r = dot.importHar(har([good]));
  assert.equal(r.room_id, room); assert.equal(r.cookies, 2);
  const saved = JSON.parse(fs.readFileSync(store.CRED_FILE, 'utf8'));
  assert.equal(saved.access_token, 'tok.en.x'); assert.equal(saved.static_headers['user-agent'], 'UA');
  assert.equal(fs.statSync(store.CRED_FILE).mode & 0o777, 0o600);
  assert.throws(() => dot.importHar(har([{ request: { method: 'GET', url: 'https://chatgpt.com/x', headers: [] } }])), /no authenticated/);
});
