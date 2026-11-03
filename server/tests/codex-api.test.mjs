// Codex 直连搜索与统一入口的测试：假 fetch + 固定 SSE，不联网、不碰真实凭据
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subpow-codex-test-'));
const AUTH = path.join(home, 'auth.json');
process.env.SUBPOW_HOME = home;
process.env.SUBPOW_CODEX_AUTH_FILE = AUTH;
process.env.SUBPOW_CODEX_VERSION = '9.9.9';
const store = await import('../lib/store.mjs');
const wire = await import('../lib/codex-wire.mjs');
const api = await import('../lib/codex-api.mjs');
const links = await import('../lib/links.mjs');
const search = await import('../lib/search.mjs');

// ───────── 夹具 ─────────
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
function writeAuth({ expInMs = 5 * 86400_000, plan = 'pro', account = 'acct-111', residency } = {}) {
  const tok = jwt({ exp: Math.floor((Date.now() + expInMs) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: plan, ...(residency && { chatgpt_data_residency: residency }) } });
  fs.writeFileSync(AUTH, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: tok, refresh_token: 'rt-secret', id_token: 'x', account_id: account }, last_refresh: '2026-11-01T00:00:00Z' }));
  return tok;
}
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const resp = (events, init = {}) => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
const completed = { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-6-luna', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } } };
const toolCall = (sources, query = 'q1') => ({ type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'search', query, sources: sources.map((url) => ({ type: 'url', url })) } } });
const message = (text, annotations = []) => ({ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text, annotations }] } });
const quickEvents = () => [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-luna' } },
  { type: 'response.web_search_call.completed' },
  toolCall(['https://a.com/1?utm_source=openai', 'https://b.com/2']),
  message(JSON.stringify({ results: [{ title: 'A', url: 'https://a.com/1?utm_source=openai', summary: 'sa' }, { title: 'C', url: 'https://c.com', summary: 'sc' }] })),
  completed,
];
/** 记录请求的假 fetch：steps 依次是 Response、Error 或函数 */
function fakeFetch(...steps) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    const v = typeof s === 'function' ? await s() : s;
    if (v instanceof Error) throw v;
    return v;
  };
  f.calls = calls;
  return f;
}
const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const sleeps = []; const sleep = async (ms) => { sleeps.push(ms); };
const run = (a, f) => api.webSearch({ query: 'q', ...a }, { fetchImpl: f, sleep });

beforeEach(() => {
  fs.rmSync(store.CONFIG_FILE, { force: true });
  store.setCodexApi({ enabled: true, min_interval_ms: 0, concurrency: 2 });
  writeAuth(); sleeps.length = 0;
});

// ───────── 纯函数 ─────────
test('tokenInfo：过期时间 / 账号 / 套餐 / 驻留区；no_constraint 不算驻留；坏令牌不抛错', () => {
  const t = jwt({ exp: 2000000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'A', chatgpt_plan_type: 'prolite', chatgpt_data_residency: 'eu' } });
  assert.deepEqual(wire.tokenInfo(t), { exp: 2000000000_000, accountId: 'A', plan: 'prolite', residency: 'eu' });
  assert.equal(wire.tokenInfo(jwt({ exp: 1, 'https://api.openai.com/auth': { chatgpt_data_residency: 'no_constraint' } })).residency, undefined);
  assert.deepEqual(wire.tokenInfo('garbage'), { exp: 0, accountId: undefined, plan: undefined, residency: undefined });
});

test('resolveResponsesUrl：三种基础地址写法都规整到 /codex/responses', () => {
  for (const b of ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/', 'https://chatgpt.com/backend-api/codex', 'https://chatgpt.com/backend-api/codex/responses/']) assert.equal(wire.resolveResponsesUrl(b), 'https://chatgpt.com/backend-api/codex/responses');
});

test('readSse：跨块的帧、CRLF、多行 data、[DONE]、坏 JSON', async () => {
  const chunks = ['data: {"type":"a"}\n\nda', 'ta: {"type":"b"}\r\n\r\ndata: {"ty', 'pe":"c",\ndata: "x":1}\n\ndata: [DONE]\n\ndata: not-json\n\ndata: {"type":"d"}'];
  async function* body() { for (const c of chunks) yield new TextEncoder().encode(c); }
  const got = []; for await (const e of api.readSse(body())) got.push(e);
  assert.deepEqual(got.map((e) => e.type), ['a', 'b', 'c', 'd']);   // 多行 data 用换行连接，仍是合法 JSON
  assert.equal(got[2].x, 1);
});

test('stripTracking / cleanUrl：只去掉 utm_source=openai，保留其它参数', () => {
  assert.equal(links.stripTracking('([a](https://x.com/p?utm_source=openai)) https://y.com/?k=1&utm_source=openai https://z.com/?utm_source=openai&k=2'), '([a](https://x.com/p)) https://y.com/?k=1 https://z.com/?k=2');
  assert.equal(links.cleanUrl('https://x.com/p?k=1&utm_source=openai'), 'https://x.com/p?k=1');
  assert.equal(links.cleanUrl('https://x.com/p?utm_source=newsletter'), 'https://x.com/p?utm_source=newsletter');
});

// ───────── 请求与解析 ─────────
test('quick：请求体 / 请求头符合协议；结果清洗、去重；usage 映射；其余来源单列', async () => {
  const tok = writeAuth({ plan: 'pro', residency: 'eu' });
  const f = fakeFetch(resp(quickEvents()));
  const r = await run({ max_results: 5 }, f);
  const c = f.calls[0];
  assert.equal(c.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(c.headers.authorization, `Bearer ${tok}`);
  assert.equal(c.headers['chatgpt-account-id'], 'acct-111');
  assert.equal(c.headers.originator, 'subscription-powers');
  assert.equal(c.headers.version, '9.9.9');
  assert.equal(c.headers['x-openai-internal-codex-residency'], 'eu');
  assert.equal(c.body.model, 'gpt-6-luna'); assert.deepEqual(c.body.reasoning, { effort: 'low' });
  assert.deepEqual(c.body.tool_choice, { type: 'web_search' }); assert.equal(c.body.tools[0].type, 'web_search');
  assert.equal(c.body.text.format.type, 'json_schema'); assert.equal(c.body.store, false); assert.equal(c.body.stream, true);
  assert.ok(!('temperature' in c.body));   // 后端会拒绝采样参数
  assert.equal(r.ok, true); assert.equal(r.backend, 'codex_api');
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.com/1', 'https://c.com/']);
  assert.deepEqual(r.other_sources, ['https://b.com/2']);
  assert.deepEqual(r.usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 });
  assert.deepEqual(r.searches_made, ['q1']); assert.equal(r.request_id, 'resp_1');
});

test('quick：没有驻留区声明时不发驻留头；max_results 截断；model / effort 可覆盖', async () => {
  const f = fakeFetch(resp(quickEvents()));
  const r = await run({ max_results: 1, model: 'gpt-6.1-sol', effort: 'high' }, f);
  assert.ok(!('x-openai-internal-codex-residency' in f.calls[0].headers));
  assert.equal(r.results.length, 1);
  assert.equal(f.calls[0].body.model, 'gpt-6.1-sol'); assert.deepEqual(f.calls[0].body.reasoning, { effort: 'high' });
});

test('deep：答案去掉跟踪参数，来源取引用注解 + 工具来源，用更强的模型和更大的搜索上下文', async () => {
  const f = fakeFetch(resp([
    { type: 'response.created', response: { id: 'r2', model: 'gpt-6.1-sol' } },
    toolCall(['https://t.com/x']),
    message('结论见 ([nodejs.org](https://nodejs.org/a?utm_source=openai))。', [{ type: 'url_citation', url: 'https://nodejs.org/a?utm_source=openai', title: 'Node.js' }]),
    completed,
  ]));
  const r = await run({ mode: 'deep', max_results: 5 }, f);
  assert.equal(f.calls[0].body.model, 'gpt-6.1-sol'); assert.equal(f.calls[0].body.tools[0].search_context_size, 'high'); assert.ok(!f.calls[0].body.text);
  assert.equal(r.answer, '结论见 ([nodejs.org](https://nodejs.org/a))。');
  assert.deepEqual(r.sources, ['https://nodejs.org/a', 'https://t.com/x']);
  assert.deepEqual(r.citations, [{ title: 'Node.js', url: 'https://nodejs.org/a' }]);
});

test('quick：模型没按 schema 输出 → 退化为引用与工具来源，并带警告', async () => {
  const f = fakeFetch(resp([toolCall(['https://b.com/2']), message('抱歉，没有 JSON', [{ type: 'url_citation', url: 'https://a.com/1', title: 'A' }]), completed]));
  const r = await run({}, f);
  assert.equal(r.ok, true); assert.match(r.warnings[0], /falling back/);
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.com/1', 'https://b.com/2']);
  assert.equal(r.results[0].title, 'A');
});

test('没有 web_search_call 事件 → codex_api_no_search，不计入熔断', async () => {
  const f = fakeFetch(resp([message('凭记忆回答'), completed]));
  const r = await run({}, f);
  assert.equal(r.code, 'codex_api_no_search'); assert.equal(store.getCodexApi().consecutive_failures, 0);
});

// ───────── 错误、重试、熔断 ─────────
test('401 连续三次 → 熔断；之后直接返回 disabled，不再发请求', async () => {
  const f = fakeFetch(() => new Response('{"error":"bad token"}', { status: 401 }));
  for (let i = 1; i <= 3; i++) { const r = await run({}, f); assert.equal(r.code, 'codex_api_unauthorized'); assert.equal(store.getCodexApi().consecutive_failures, i); }
  assert.equal(store.getCodexApi().tripped, true); assert.equal(store.codexApiActive(), false);
  const n = f.calls.length; const r = await run({}, f);
  assert.equal(r.code, 'codex_api_disabled'); assert.match(r.message, /auto-disabled/); assert.equal(f.calls.length, n);
});

test('成功会清零连续失败计数', async () => {
  store.setCodexApi({ consecutive_failures: 2 });
  await run({}, fakeFetch(resp(quickEvents())));
  assert.equal(store.getCodexApi().consecutive_failures, 0);
});

test('Cloudflare 挑战页（HTML）→ codex_api_blocked 并计入熔断', async () => {
  const r = await run({}, fakeFetch(() => new Response('<!DOCTYPE html><title>Just a moment</title>', { status: 403 })));
  assert.equal(r.code, 'codex_api_blocked'); assert.equal(store.getCodexApi().consecutive_failures, 1);
});

test('429 带 Retry-After 且在预算内 → 等待后重试成功；超出预算 → 直接返回 rate_limited，不计入熔断', async () => {
  const f = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }), resp(quickEvents()));
  assert.equal((await run({}, f)).ok, true); assert.deepEqual(sleeps, [3000]); assert.equal(f.calls.length, 2);
  const g = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }));
  const r = await run({}, g);
  assert.equal(r.code, 'codex_api_rate_limited'); assert.equal(g.calls.length, 1); assert.equal(store.getCodexApi().consecutive_failures, 0);
});

test('网络错误与 5xx：退避重试最多 2 次；仍失败返回 codex_api_network，不计入熔断', async () => {
  const f = fakeFetch(netErr(), () => new Response('boom', { status: 503 }), resp(quickEvents()));
  assert.equal((await run({}, f)).ok, true); assert.deepEqual(sleeps, [1000, 2000]); assert.equal(f.calls.length, 3);
  sleeps.length = 0;
  const g = fakeFetch(netErr());
  const r = await run({}, g);
  assert.equal(r.code, 'codex_api_network'); assert.match(r.message, /ECONNRESET/); assert.equal(g.calls.length, 3); assert.equal(store.getCodexApi().consecutive_failures, 0);
});

test('流中途的 response.failed：按文本归类；服务端类错误可重试', async () => {
  const failed = (message, code) => resp([{ type: 'response.failed', response: { error: { code, message } } }]);
  assert.equal((await run({}, fakeFetch(failed('You exceeded your current quota', 'usage_limit')))).code, 'codex_api_rate_limited');
  assert.equal((await run({}, fakeFetch(failed('Unauthorized', 'auth')))).code, 'codex_api_unauthorized');
  const f = fakeFetch(failed('The server had an error', 'server_error'), resp(quickEvents()));
  assert.equal((await run({}, f)).ok, true); assert.equal(f.calls.length, 2);
});

test('400 → codex_api_bad_request，不重试、不计入熔断', async () => {
  const f = fakeFetch(() => new Response('{"detail":"Unsupported parameter"}', { status: 400 }));
  const r = await run({}, f);
  assert.equal(r.code, 'codex_api_bad_request'); assert.match(r.message, /Unsupported parameter/); assert.equal(f.calls.length, 1); assert.equal(store.getCodexApi().consecutive_failures, 0);
});

// ───────── 凭据（只读借用）─────────
test('令牌已过期 → codex_api_token_expired，不发请求、不计入熔断，且绝不改动登录文件', async () => {
  writeAuth({ expInMs: -3600_000 });
  const before = fs.readFileSync(AUTH, 'utf8'); const mtime = fs.statSync(AUTH).mtimeMs;
  const f = fakeFetch(resp(quickEvents()));
  const r = await run({}, f);
  assert.equal(r.code, 'codex_api_token_expired'); assert.equal(f.calls.length, 0); assert.equal(store.getCodexApi().consecutive_failures, 0);
  assert.equal(fs.readFileSync(AUTH, 'utf8'), before); assert.equal(fs.statSync(AUTH).mtimeMs, mtime);
});

test('只读保证：成功、失败之后登录文件字节不变；返回结果里不含刷新令牌', async () => {
  const tok = writeAuth(); const before = fs.readFileSync(AUTH, 'utf8');
  await run({}, fakeFetch(resp(quickEvents())));
  const r = await run({}, fakeFetch(() => new Response(`echo ${tok}`, { status: 400 })));
  assert.equal(fs.readFileSync(AUTH, 'utf8'), before);
  assert.ok(!JSON.stringify(r).includes('rt-secret'));
});

test('登录文件缺失 / 不是 ChatGPT 登录 → codex_api_no_credentials，不计入熔断', async () => {
  fs.rmSync(AUTH); assert.equal((await run({}, fakeFetch())).code, 'codex_api_no_credentials');
  fs.writeFileSync(AUTH, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }));
  const r = await run({}, fakeFetch()); assert.equal(r.code, 'codex_api_no_credentials'); assert.match(r.message, /apikey/);
  assert.equal(store.getCodexApi().consecutive_failures, 0);
});

test('套餐变化（Pro 到期）→ 立即熔断，不发请求；账号变化同理', async () => {
  store.setCodexApi({ bound_plan: 'pro', bound_account: 'acct-111' });
  writeAuth({ plan: 'plus' });
  const f = fakeFetch(resp(quickEvents()));
  const r = await run({}, f);
  assert.equal(r.code, 'codex_api_disabled'); assert.match(r.message, /plan_changed: pro → plus/); assert.equal(f.calls.length, 0);
  assert.equal(store.getCodexApi().tripped, true);
  store.setCodexApi({ tripped: false, bound_plan: 'plus' }); writeAuth({ plan: 'plus', account: 'acct-222' });
  assert.match((await run({}, f)).message, /account_changed/);
});

test('关闭时：不读登录文件、不发请求', async () => {
  store.setCodexApi({ enabled: false }); fs.rmSync(AUTH);
  const f = fakeFetch(resp(quickEvents()));
  const r = await run({}, f);
  assert.equal(r.code, 'codex_api_disabled'); assert.match(r.message, /switched off/); assert.equal(f.calls.length, 0);
});

test('并发上限：6 个同时请求，同一时刻在途请求不超过 concurrency', async () => {
  store.setCodexApi({ concurrency: 2 });
  let inflight = 0, peak = 0;
  const f = fakeFetch(async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 15)); inflight--; return resp(quickEvents()); });
  const rs = await Promise.all(Array.from({ length: 6 }, () => run({}, f)));
  assert.ok(rs.every((r) => r.ok)); assert.equal(peak, 2); assert.ok(rs.some((r) => r.queued_ms > 0));
});

// ───────── 配置与统一入口 ─────────
test('配置：codex_api 默认关闭；搜索顺序默认值，非法配置回退默认', () => {
  fs.rmSync(store.CONFIG_FILE, { force: true });
  assert.equal(store.getCodexApi().enabled, false); assert.equal(store.codexApiActive(), false);
  assert.deepEqual(store.getSearchOrder(), ['dot', 'codex_api', 'chatgpt_web', 'codex_cli']);
  store.setSearchOrder(['codex_api', 'codex_cli']); assert.deepEqual(store.getSearchOrder(), ['codex_api', 'codex_cli']);
  store.setSearchOrder(['nope']); assert.deepEqual(store.getSearchOrder(), ['dot', 'codex_api', 'chatgpt_web', 'codex_cli']);
});

const reg = (spec) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, { available: () => v.why ?? null, run: async (a) => { v.seen?.push(a); return v.r; } }]));
const ok = (extra) => ({ ok: true, results: [{ title: 't', url: 'https://u.com/', summary: '' }], ...extra });

test('统一入口：按顺序尝试，未开启的跳过（不算失败），失败则换下一个，并记录 attempts / skipped', async () => {
  const r = await search.webSearch({ query: 'q' }, { registry: reg({ dot: { why: 'switched off' }, codex_api: { r: { ok: false, code: 'codex_api_network', message: 'x' } }, codex_cli: { r: ok({ model: 'cli' }) } }) });
  assert.equal(r.ok, true); assert.equal(r.backend, 'codex_cli');
  assert.deepEqual(r.skipped, [{ backend: 'dot', reason: 'switched off' }]);
  assert.deepEqual(r.attempts.map((x) => [x.backend, x.ok, x.code]), [['codex_api', false, 'codex_api_network'], ['codex_cli', true, undefined]]);
});

test('统一入口：第一个成功就不再尝试后面的；顺序取自配置，backends 参数可覆盖', async () => {
  const seen = { dot: [], codex_api: [], codex_cli: [] };
  const registry = reg({ dot: { r: ok(), seen: seen.dot }, codex_api: { r: ok(), seen: seen.codex_api }, codex_cli: { r: ok(), seen: seen.codex_cli } });
  store.setSearchOrder(['codex_api', 'dot', 'codex_cli']);
  assert.equal((await search.webSearch({ query: 'q' }, { registry })).backend, 'codex_api');
  assert.equal(seen.dot.length, 0);
  assert.equal((await search.webSearch({ query: 'q', backends: ['codex_cli'] }, { registry })).backend, 'codex_cli');
});

test('统一入口：invalid_input 立即返回；全部失败 / 全部不可用给出明确的错误码', async () => {
  const bad = reg({ dot: { r: { ok: false, code: 'invalid_input', message: 'bad' } }, codex_api: { r: ok() } });
  const r1 = await search.webSearch({ query: 'q', backends: ['dot', 'codex_api'] }, { registry: bad });
  assert.equal(r1.code, 'invalid_input'); assert.equal(r1.attempts.length, 1);
  const allFail = reg({ dot: { r: { ok: false, code: 'dot_timeout', message: 'a' } }, codex_api: { r: { ok: false, code: 'codex_api_server', message: 'b' } } });
  const r2 = await search.webSearch({ query: 'q', backends: ['dot', 'codex_api'] }, { registry: allFail });
  assert.equal(r2.code, 'all_backends_failed'); assert.match(r2.message, /dot: dot_timeout; codex_api: codex_api_server/);
  const none = reg({ dot: { why: 'switched off' }, codex_api: { why: 'auto-disabled (x)' } });
  const r3 = await search.webSearch({ query: 'q', backends: ['dot', 'codex_api'] }, { registry: none });
  assert.equal(r3.code, 'no_backend_available'); assert.equal(r3.skipped.length, 2);
});

test('统一入口：后端抛出异常也按失败处理并继续', async () => {
  const registry = { dot: { available: () => null, run: async () => { throw new Error('kaboom'); } }, codex_cli: { available: () => null, run: async () => ok() } };
  const r = await search.webSearch({ query: 'q', backends: ['dot', 'codex_cli'] }, { registry });
  assert.equal(r.backend, 'codex_cli'); assert.equal(r.attempts[0].code, 'exception');
});
