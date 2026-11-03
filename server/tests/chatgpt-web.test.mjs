// 固定网页会话搜索：纯解析 + 假 bridge / 假会话接口，不联网、不碰真实浏览器和凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SUBPOW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'subpow-web-'));
delete process.env.SUBPOW_CHATGPT_SESSION_URL;
const store = await import('../lib/store.mjs');
const web = await import('../lib/chatgpt-web.mjs');

const CID = '11111111-2222-4333-8444-555555555555', PROJ = `g-p-${'a'.repeat(32)}`;
const URL_ = `https://chatgpt.com/g/${PROJ}-only-for-local-agent-websearch/c/${CID}`;

test('parseSessionUrl：带项目 / 不带项目的会话网址；其它一律拒绝', () => {
  assert.deepEqual(web.parseSessionUrl(URL_), { conversation_id: CID, project_id: PROJ });
  assert.deepEqual(web.parseSessionUrl(`https://chatgpt.com/c/${CID.toUpperCase()}`), { conversation_id: CID, project_id: null });
  for (const bad of ['', 'nope', `http://chatgpt.com/c/${CID}`, `https://evil.com/c/${CID}`, `https://chatgpt.com/dots/x~y`, 'https://chatgpt.com/c/not-a-uuid', `https://chatgpt.com/c/${CID}/extra`]) assert.equal(web.parseSessionUrl(bad), null, bad);
});

test('stripCitations：去掉 <Cite/> 与私有区引用，整理空行', () => {
  assert.equal(web.stripCitations('结果 **Go 1.27.3**。<Cite ref="turn1search1"/>\n\n\n\n后文citeturn0。'), '结果 **Go 1.27.3**。\n\n后文。');
});

// 造会话消息树：根 → 用户 → 助手(调用搜索) → 工具(结果) → 助手前言(end_turn) → 助手正式回答(end_turn，叶子)
const msg = (role, extra = {}) => ({ author: { role }, content: { content_type: 'text', parts: [''] }, recipient: 'all', status: 'finished_successfully', end_turn: null, metadata: {}, create_time: 0, ...extra });
function tree(userText, { finish = true, final = '答案。<Cite ref="x"/>', entries, model = 'gpt-6' } = {}) {
  const ents = entries ?? [{ type: 'search_result', url: 'https://a.com/x?utm_source=chatgpt.com', title: 'A', snippet: 'sa', pub_date: '2026-10-01', attribution: 'a.com' }, { type: 'search_result', url: 'https://a.com/x', title: 'A dup' }, { url: 'https://b.com/', title: '', attribution: 'b.com', snippet: 'sb' }];
  const m = { root: { id: 'root', message: null, children: ['u'] }, u: { id: 'u', message: msg('user', { content: { content_type: 'text', parts: [userText] }, create_time: 1 }), children: ['a1'] },
    a1: { id: 'a1', message: msg('assistant', { recipient: 'web.run', create_time: 2 }), children: ['t'] },
    t: { id: 't', message: msg('tool', { create_time: 3, metadata: { search_result_groups: [{ type: 'search_result_group', domain: 'x', entries: ents }] } }), children: ['p'] },
    p: { id: 'p', message: msg('assistant', { create_time: 4, end_turn: true, content: { content_type: 'text', parts: ['前言'] }, metadata: { resolved_model_slug: model } }), children: finish ? ['f'] : [] } };
  if (finish) m.f = { id: 'f', message: msg('assistant', { create_time: 5, end_turn: true, content: { content_type: 'text', parts: [final] }, metadata: { resolved_model_slug: model } }), children: [] };
  return m;
}

test('readTurn：按随机标记找到我这条；有子节点的前言不算末端；末端含标记才是确定完成', () => {
  assert.equal(web.readTurn(tree('hi [[END:abc123]]'), '[[END:zzzzzz]]'), null);
  const pre = web.readTurn(tree('q [[END:abc123]]', { finish: false }), '[[END:abc123]]');   // 只有前言，它此刻是叶子
  assert.equal(pre.done, true); assert.equal(pre.hasMarker, false); assert.equal(pre.text, '前言'); assert.equal(pre.searched, true);
  const t = web.readTurn(tree('q [[END:abc123]]'), '[[END:abc123]]');
  assert.equal(t.done, true); assert.equal(t.text, '答案。'); assert.equal(t.hasMarker, false); assert.equal(t.model, 'gpt-6'); assert.equal(t.entries.length, 3);
  assert.equal(web.readTurn(tree('q [[END:abc123]]', { final: '答案 [[END:abc123]]' }), '[[END:abc123]]').hasMarker, true);
});

test('toResults：去重、去 utm_source、标题兜底为来源站点、按 n 截断、带日期', () => {
  const r = web.toResults(web.readTurn(tree('q [[END:abc123]]'), '[[END:abc123]]').entries, 10);
  assert.deepEqual(r, [{ title: 'A', url: 'https://a.com/x', summary: 'sa', published: '2026-10-01' }, { title: 'b.com', url: 'https://b.com/', summary: 'sb' }]);
  assert.equal(web.toResults(web.readTurn(tree('q [[END:abc123]]'), '[[END:abc123]]').entries, 1).length, 1);
  assert.equal(web.toResults([{ url: 'https://c.com/', title: 'C', pub_date: 1791504000 }], 5)[0].published, '2026-10-09');   // 时间戳 → 日期
});

test('toResults：同一网址在工具节点（无摘要）和助手节点（有摘要）各出现一次时合并补全', () => {
  const r = web.toResults([{ url: 'https://a.com/', title: 'A' }, { url: 'https://b.com/?utm_source=chatgpt.com', title: 'B' }, { url: 'https://a.com/', title: 'A', snippet: '  摘要\n一  ', pub_date: 1791504000 }], 10);
  assert.deepEqual(r, [{ title: 'A', url: 'https://a.com/', summary: '摘要 一', published: '2026-10-09' }, { title: 'B', url: 'https://b.com/', summary: '' }]);
});

test('buildPrompt：单行、带结束标记、禁止其它工具；quick 只要标记，deep 要回答和 Sources', () => {
  const q = web.buildPrompt('quick', { query: '多行\n问题', recency: 'week' }, 10, '[[END:abc123]]');
  assert.ok(!q.includes('\n') && q.includes('[[END:abc123]]') && /ONLY your built-in web search/.test(q) && /last week/.test(q));
  const d = web.buildPrompt('deep', { query: 'x' }, 5, '[[END:abc123]]');
  assert.ok(/Sources/.test(d) && /last line/.test(d));
});

test('开关与配置：默认关；没配置会话 → chatgpt_web_no_session 且不计入熔断', async () => {
  fs.rmSync(store.CONFIG_FILE, { force: true });
  assert.equal(store.getChatgptWeb().enabled, false); assert.equal(store.chatgptWebActive(), false);
  const off = await web.webSearch({ query: 'q' });
  assert.equal(off.code, 'chatgpt_web_disabled');
  store.setChatgptWeb({ enabled: true, min_interval_ms: 0 });
  for (let i = 0; i < 4; i++) assert.equal((await web.webSearch({ query: 'q' })).code, 'chatgpt_web_no_session');
  assert.equal(store.getChatgptWeb().tripped, false); assert.equal(store.getChatgptWeb().consecutive_failures, 0);
  assert.match((await web.webSearch({ query: 'q' })).message, /web session set/);
});

test('setSession：验证后才保存；归档 / 项目不符 / 网址不对都拒绝', async () => {
  const conv = { title: 'only-for-local-agent-websearch', gizmo_id: PROJ, is_archived: false, mapping: {} };
  const r = await web.setSession(URL_, { api: async () => conv });
  assert.equal(r.title, conv.title); assert.equal(store.getChatgptWeb().conversation_id, CID);
  await assert.rejects(web.setSession(URL_, { api: async () => ({ ...conv, is_archived: true }) }), { code: 'chatgpt_web_session_invalid' });
  await assert.rejects(web.setSession(URL_, { api: async () => ({ ...conv, gizmo_id: 'g-p-' + 'b'.repeat(32) }) }), { code: 'chatgpt_web_session_invalid' });
  await assert.rejects(web.setSession('https://example.com/x', { api: async () => conv }), { code: 'chatgpt_web_bad_url' });
  store.setChatgptWeb({ session_url: null, conversation_id: null, project_id: null });
});

/** 假页面 + 假会话：按回车后，用户消息（带我们填进去的文字）才出现在会话里 */
function fake({ tabUrl = URL_, draft = 0, enterWorks = true, build = (text) => tree(text), steps = 1 } = {}) {
  const st = { typed: null, sent: false, calls: [], gets: 0, cleared: 0 };
  const bridge = {
    async call(name, args) {
      st.calls.push(name === 'browser_cdp_send' ? args.method : name);
      if (name === 'browser_list_tabs') return { tabs: tabUrl ? [{ id: 9, url: tabUrl }] : [{ id: 1, url: 'https://chatgpt.com/dots/x~y' }] };
      if (name === 'browser_cdp_attach') return { sessionId: 's' };
      if (name === 'browser_cdp_send') {
        if (args.method === 'Input.insertText') st.typed = args.params.text;
        if (args.method === 'Input.dispatchKeyEvent' && args.params.type === 'keyDown' && enterWorks) st.sent = true;
        if (args.method === 'Runtime.evaluate') { if (/innerText/.test(args.params.expression)) return { result: { result: { value: draft ? { text: draft, visible: 'visible' } : { text: 0, visible: 'visible' } } } }; if (/selectAll/.test(args.params.expression)) st.cleared++; return { result: { result: { value: null } } }; }
        return {};
      }
      return {};
    },
    close: async () => {},
  };
  const api = async () => { st.gets++; if (!st.sent) return { title: 't', gizmo_id: PROJ, is_archived: false, mapping: { root: { id: 'root', message: null, children: [] } } }; const m = build(st.typed); return { title: 't', gizmo_id: PROJ, is_archived: false, mapping: st.gets - 1 >= steps ? m : tree(st.typed, { finish: false }) }; };
  return { st, bridge, api };
}
const configure = () => { fs.rmSync(store.CONFIG_FILE, { force: true }); store.setChatgptWeb({ enabled: true, min_interval_ms: 0, session_url: URL_, conversation_id: CID, project_id: PROJ }); };
const run = (f, a, o = {}) => web.webSearch(a, { api: f.api, bridge: f.bridge, pollMs: 5, sendWaitMs: 80, ...o });

test('quick：填字回车 → 轮询到这一轮结束 → 返回结构化来源，不依赖模型文字', async () => {
  configure(); const f = fake({ steps: 2 });
  const r = await run(f, { query: 'Go 最新版本', max_results: 5 });
  assert.ok(f.st.gets >= 4, '没有标记时要等内容连续不变，不能拿到前言就返回');
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.backend, 'chatgpt_web'); assert.equal(r.mode, 'quick');
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.com/x', 'https://b.com/']); assert.equal(r.model, 'gpt-6');
  assert.match(f.st.typed, /Go 最新版本/); assert.match(f.st.typed, /\[\[END:[0-9a-f]{6}\]\]/);
  assert.ok(f.st.calls.includes('Input.insertText') && f.st.calls.includes('Input.dispatchKeyEvent'));
  assert.equal(f.st.calls.at(-1), 'browser_cdp_detach'); assert.equal(store.getChatgptWeb().consecutive_failures, 0);
});

test('deep：返回去掉引用标记和结束标记的回答，来源合并结构化条目与正文链接', async () => {
  configure(); let marker;
  const f = fake({ build: (text) => { marker = text.match(/\[\[END:[0-9a-f]{6}\]\]/)[0]; return tree(text, { final: `Go 1.27.3。<Cite ref="x"/> 见 [官网](https://go.dev/dl/)\n${marker}` }); } });
  const r = await run(f, { query: 'Go 版本', mode: 'deep', max_results: 5 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.answer, 'Go 1.27.3。 见 [官网](https://go.dev/dl/)');
  assert.deepEqual(r.sources, ['https://a.com/x', 'https://b.com/', 'https://go.dev/dl/']);
});

test('没有打开会话标签页 / 输入框里有草稿：明确报错、什么都不发、都不计入熔断', async () => {
  configure();
  let f = fake({ tabUrl: null }); let r = await run(f, { query: 'q' });
  assert.equal(r.code, 'chatgpt_web_no_tab'); assert.ok(!f.st.calls.includes('Input.insertText'));
  f = fake({ draft: 12 }); r = await run(f, { query: 'q' });
  assert.equal(r.code, 'chatgpt_web_composer_busy'); assert.ok(!f.st.calls.includes('Input.insertText'));
  assert.equal(store.getChatgptWeb().consecutive_failures, 0);
});

test('发送后消息始终没出现：清掉填进去的字，报 send_failed，连续 3 次熔断并隐藏工具', async () => {
  configure();
  for (let i = 1; i <= 3; i++) {
    const f = fake({ enterWorks: false }); const r = await run(f, { query: 'q' });
    assert.equal(r.code, 'chatgpt_web_send_failed'); assert.equal(f.st.cleared, 1);
    assert.equal(store.getChatgptWeb().consecutive_failures, i);
  }
  const c = store.getChatgptWeb(); assert.equal(c.tripped, true); assert.equal(store.chatgptWebActive(c), false);
  assert.equal((await web.webSearch({ query: 'q' })).code, 'chatgpt_web_disabled');
});

test('会话被归档 / 模型没搜索就回答：分别报错；没搜索不计入熔断', async () => {
  configure();
  const arch = fake(); arch.api = async () => ({ title: 't', gizmo_id: PROJ, is_archived: true, mapping: {} });
  assert.equal((await run(arch, { query: 'q' })).code, 'chatgpt_web_session_invalid'); assert.equal(arch.st.calls.includes('Input.insertText'), false);
  configure();
  const ns = fake({ build: (text) => { const m = tree(text, { entries: [] }); delete m.t; m.a1.children = ['p']; return m; } });
  assert.equal((await run(ns, { query: 'q' })).code, 'chatgpt_web_no_search'); assert.equal(store.getChatgptWeb().consecutive_failures, 0);
});

test('前言先出现、正式回答随后才写出：不会把前言当成答案返回', async () => {
  configure(); let marker;
  const f = fake({ steps: 3, build: (text) => { marker = text.match(/\[\[END:[0-9a-f]{6}\]\]/)[0]; return tree(text, { final: `正式回答 ${marker}` }); } });
  const r = await run(f, { query: 'x', mode: 'deep' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.answer, '正式回答');
});

test('真实形态：回答在倒数第二条 end_turn 节点里，末端只是 <escape>[[END:…]]</escape>：答案取前者，完成看末端', () => {
  const m = tree('q [[END:abc123]]'); m.f.message.content.parts = ['<escape>[[END:abc123]]</escape>']; m.p.message.content.parts = ['结论 **1.27.3**。\n\n<escape>[[END:abc123]]</escape>'];
  const t = web.readTurn(m, '[[END:abc123]]');
  assert.equal(t.done, true); assert.equal(t.hasMarker, true); assert.equal(t.text, '结论 **1.27.3**。');
  // 只有收尾、没有任何回答文字 → text 为空（deep 会据此报 bad_output，而不是返回空壳）
  m.p.message.content.parts = ['<escape>[[END:abc123]]</escape>'];
  assert.equal(web.readTurn(m, '[[END:abc123]]').text, '');
});
