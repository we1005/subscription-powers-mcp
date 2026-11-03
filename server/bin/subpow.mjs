#!/usr/bin/env node
/** subpow —— 管理 subscription-powers 的本地开关与登录态。用法见 `subpow help` */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDot, setDot, dotActive, getChatgptWeb, setChatgptWeb, chatgptWebActive, getCodexApi, setCodexApi, codexApiActive, getSearchOrder, setSearchOrder, SEARCH_BACKENDS, readJson, CONFIG_FILE, CRED_FILE } from '../lib/store.mjs';
import * as dot from '../lib/dot.mjs';
import * as codexApi from '../lib/codex-api.mjs';
import * as web from '../lib/chatgpt-web.mjs';
import { authFile } from '../lib/codex-auth.mjs';
import * as search from '../lib/search.mjs';

const [area, cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const say = (...a) => console.log(...a);
const days = (iso) => iso ? `${((Date.parse(iso) - Date.now()) / 86400_000).toFixed(1)} 天后（${iso.slice(0, 16)}）` : '未知';
const jwtExpIso = (t) => new Date(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).exp * 1000).toISOString();

function recentCalls(match) {
  const f = path.join(os.homedir(), '.cache', 'subscription-powers', 'calls.jsonl');
  try {
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-600).map((l) => JSON.parse(l)).filter(match).slice(-10);
    if (!rows.length) return '暂无记录';
    const ok = rows.filter((r) => r.ok).length;
    return `最近 ${rows.length} 次：${ok} 成功 / ${rows.length - ok} 失败；平均 ${Math.round(rows.reduce((s, r) => s + (r.run_ms ?? 0), 0) / rows.length / 1000)} s`;
  } catch { return '暂无记录'; }
}
const HELP = `subpow dot status | on [--force] | off | reset | check | import-har <file> | capture [--dry-run] [--open] [--browser X] | auto-capture on|off | search "<q>" [--mode quick|deep] [--n 10] [--force]
    Dot（ChatGPT Pro 消息接口）：开关、熔断、登录态。search 会向 Dot 发一条真实消息
    capture：借日常 Chrome 的 Dot 标签页（经 chrome-agent-bridge）自动抓登录态；--dry-run 只验证不保存
    auto-capture on：登录态失效时自动重抓（会短暂附加调试器，默认关）

subpow codex status | on [--live] | off | reset | check [--live] | login | search "<q>" [--mode quick|deep] [--n 10] [--model M] [--effort E]
    Codex 直连 Responses 接口（只读借用 ~/.codex/auth.json 的令牌）。--live 会真的发一个最小请求验证
    login 是方案 A（自建 OAuth 登录），尚未实现（TODO）

subpow web status | session set <url> | session show | session clear | on [--force] | off | reset | check | search "<q>" [--mode quick|deep] [--n 10] [--force]
    固定 ChatGPT 网页会话搜索（驱动页面）：必须先 session set 指定会话网址；需要 Chrome 开着该会话页面。search 会向该会话发一条真实消息

subpow search status | order <a,b,c> | run "<q>" [--mode quick|deep] [--n 10] [--backends a,b]
    统一搜索入口：后端 ${SEARCH_BACKENDS.join(' / ')}，按顺序尝试

状态目录：${path.dirname(CONFIG_FILE)}`;

async function dotMain() {
  if (cmd === 'status') {
    const c = getDot(), cred = readJson(CRED_FILE, null);
    say(`开关 enabled        : ${c.enabled ? '开' : '关'}`);
    say(`熔断 tripped        : ${c.tripped ? `是 — ${c.tripped_reason}` : '否'}（连续失败 ${c.consecutive_failures}/${c.trip_after}）`);
    say(`对外提供工具        : ${dotActive(c) ? '是（dot_web_search 已注册）' : '否（dot_web_search 已隐藏）'}`);
    say(`登录态              : ${cred ? `已保存，捕获于 ${cred.captured_at?.slice(0, 16)}；令牌 ${days(jwtExpIso(cred.access_token))}；会话 ${days(cred.session_expires)}` : '无（先 import-har）'}`);
    say(`自动重抓登录态      : ${c.auto_recapture ? `开（冷却 ${c.recapture_cooldown_ms / 60000} 分钟；上次 ${c.last_recapture_at?.slice(0, 16) ?? '从未'}）` : '关（subpow dot auto-capture on 开启）'}`);
    say(`最近调用            : ${recentCalls((r) => r.tool === 'dot_web_search' || r.backend === 'dot')}`);
    return;
  }
  if (cmd === 'off') { setDot({ enabled: false }); say('已关闭 Dot 搜索。'); return; }
  if (cmd === 'reset') { setDot({ tripped: false, tripped_reason: null, consecutive_failures: 0 }); say('已清除熔断状态。'); return; }
  if (cmd === 'check') { const r = await dot.check(); say(JSON.stringify(r, null, 1)); process.exitCode = r.ok ? 0 : 1; return; }
  if (cmd === 'on') {
    if (!flag('force')) {
      const r = await dot.check();
      if (!r.ok) { say(`拒绝开启：健康检查失败 — ${r.code}: ${r.message}\n（确认无误可加 --force）`); process.exitCode = 1; return; }
      say(`健康检查通过（令牌到 ${r.token_expires.slice(0, 16)}，会话到 ${String(r.session_expires).slice(0, 10)}）`);
    }
    setDot({ enabled: true, tripped: false, tripped_reason: null, consecutive_failures: 0 });
    say('已开启 Dot 搜索。运行中的 MCP 会在 2 秒内显示 dot_web_search。');
    return;
  }
  if (cmd === 'import-har') {
    if (!rest[0]) { say('用法：subpow dot import-har <file.har>'); process.exitCode = 2; return; }
    say(JSON.stringify(dot.importHar(rest[0]), null, 1));
    return;
  }
  if (cmd === 'capture') {
    const { capture } = await import('../lib/dot-capture.mjs');
    try {
      const r = await capture({ dryRun: flag('dry-run'), open: flag('open'), browser: opt('browser'), timeoutMs: opt('timeout') ? Number(opt('timeout')) * 1000 : undefined });
      say(JSON.stringify(r, null, 1));
      say(r.saved ? '已保存新登录态。' : '试运行通过：抓到的登录态可用（未保存）。');
    } catch (e) { say(`抓取失败：${e.code ?? ''} ${e.message}`); process.exitCode = 1; }
    return;
  }
  if (cmd === 'auto-capture') {
    if (!['on', 'off'].includes(rest[0])) { say('用法：subpow dot auto-capture on|off'); process.exitCode = 2; return; }
    setDot({ auto_recapture: rest[0] === 'on' });
    say(rest[0] === 'on' ? '已开启：登录态失效时会自动从日常 Chrome 重抓（需要 chrome-agent-bridge 和一个已登录的 Dot 标签页）。' : '已关闭自动重抓。');
    return;
  }
  if (cmd === 'search') {
    const q = rest.find((x) => !x.startsWith('--') && x !== opt('mode') && x !== opt('n'));
    if (!q) { say('用法：subpow dot search "<query>" [--mode deep]'); process.exitCode = 2; return; }
    const r = await dot.webSearch({ query: q, mode: opt('mode'), max_results: opt('n') ? Number(opt('n')) : undefined }, { force: flag('force') });
    say(JSON.stringify(r, null, 1));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  say(`未知命令：dot ${cmd}（subpow help）`); process.exitCode = 2;
}

async function codexMain() {
  const live = async () => codexApi.webSearch({ query: 'Node.js 当前的 LTS 版本号', mode: 'quick', max_results: 3 });
  if (cmd === 'status') {
    const c = getCodexApi(), k = codexApi.check();
    say(`开关 enabled        : ${c.enabled ? '开' : '关'}`);
    say(`熔断 tripped        : ${c.tripped ? `是 — ${c.tripped_reason}` : '否'}（连续失败 ${c.consecutive_failures}/${c.trip_after}）`);
    say(`对外提供工具        : ${codexApiActive(c) ? '是（codex_api_search 已注册）' : '否（codex_api_search 已隐藏）'}`);
    say(`绑定的套餐 / 账号   : ${c.bound_plan ?? '未记录'} / ${c.bound_account ? c.bound_account.slice(0, 8) + '…' : '未记录'}（开启时记录，之后变了会立即熔断）`);
    say(`凭据（只读借用）    : ${authFile()}`);
    say(k.ok ? `令牌                : 套餐 ${k.plan}；${days(k.token_expires)}；Codex 上次刷新 ${String(k.last_refresh).slice(0, 16)}` : `令牌                : 不可用 — ${k.code}: ${k.message}`);
    say(`最近调用            : ${recentCalls((r) => r.tool === 'codex_api_search' || r.backend === 'codex_api')}`);
    return;
  }
  if (cmd === 'off') { setCodexApi({ enabled: false }); say('已关闭 Codex 直连搜索。'); return; }
  if (cmd === 'reset') { setCodexApi({ tripped: false, tripped_reason: null, consecutive_failures: 0 }); say('已清除熔断状态。'); return; }
  if (cmd === 'login') {
    say('TODO：方案 A（自建 OAuth 登录、独立保存令牌）尚未实现，计划见 docs/codex-oauth-websearch-plan.zh.md §4。\n当前使用方案 B：只读借用 ~/.codex/auth.json。请先用 Codex CLI 登录（`codex login`）。');
    return;
  }
  if (cmd === 'check') {
    const k = codexApi.check(); say(JSON.stringify(k, null, 1));
    if (k.ok && flag('live')) { const was = getCodexApi(); setCodexApi({ enabled: true }); const r = await live(); setCodexApi({ enabled: was.enabled }); say(`live: ${r.ok ? `成功（${r.results.length} 条，${(r.elapsed_ms / 1000).toFixed(1)} s，${r.model}）` : `失败 — ${r.code}: ${r.message}`}`); process.exitCode = r.ok ? 0 : 1; return; }
    process.exitCode = k.ok ? 0 : 1; return;
  }
  if (cmd === 'on') {
    const k = codexApi.check();
    if (!k.ok) { say(`拒绝开启：${k.code}: ${k.message}`); process.exitCode = 1; return; }
    const auth = (await import('../lib/codex-auth.mjs')).readCodexAuth();
    if (flag('live')) {
      const was = getCodexApi(); setCodexApi({ enabled: true, tripped: false, tripped_reason: null, consecutive_failures: 0, bound_plan: null, bound_account: null });
      const r = await live();
      if (!r.ok) { setCodexApi({ enabled: was.enabled }); say(`拒绝开启：实际请求失败 — ${r.code}: ${r.message}`); process.exitCode = 1; return; }
      say(`实际请求通过（${(r.elapsed_ms / 1000).toFixed(1)} s，${r.model}）`);
    }
    setCodexApi({ enabled: true, tripped: false, tripped_reason: null, consecutive_failures: 0, bound_plan: auth.plan ?? null, bound_account: auth.accountId });
    say(`已开启 Codex 直连搜索（套餐 ${auth.plan}，令牌${days(k.token_expires)}）。运行中的 MCP 会在 2 秒内显示 codex_api_search。`);
    return;
  }
  if (cmd === 'search') {
    const q = rest.find((x) => !x.startsWith('--') && ![opt('mode'), opt('n'), opt('model'), opt('effort')].includes(x));
    if (!q) { say('用法：subpow codex search "<query>" [--mode deep]'); process.exitCode = 2; return; }
    const r = await codexApi.webSearch({ query: q, mode: opt('mode'), max_results: opt('n') ? Number(opt('n')) : undefined, model: opt('model'), effort: opt('effort') });
    say(JSON.stringify(r, null, 1)); process.exitCode = r.ok ? 0 : 1;
    return;
  }
  say(`未知命令：codex ${cmd}（subpow help）`); process.exitCode = 2;
}

async function webMain() {
  const sess = () => { try { const s = web.sessionConfig(); return s; } catch { return null; } };
  if (cmd === 'status') {
    const c = getChatgptWeb(), s = sess();
    say(`开关 enabled        : ${c.enabled ? '开' : '关'}`);
    say(`熔断 tripped        : ${c.tripped ? `是 — ${c.tripped_reason}` : '否'}（连续失败 ${c.consecutive_failures}/${c.trip_after}）`);
    say(`对外提供工具        : ${chatgptWebActive(c) ? '是（chatgpt_web_search 已注册）' : '否（chatgpt_web_search 已隐藏）'}`);
    say(`固定会话            : ${s ? `${s.conversation_id}${s.project_id ? `（项目 ${s.project_id.slice(0, 12)}…）` : ''}${process.env.SUBPOW_CHATGPT_SESSION_URL ? '，来自环境变量' : ''}` : '未设置（subpow web session set <网址>）'}`);
    say(`最近调用            : ${recentCalls((r) => r.tool === 'chatgpt_web_search' || r.backend === 'chatgpt_web')}`);
    return;
  }
  if (cmd === 'session') {
    const [sub, url] = rest;
    if (sub === 'show') { const s = sess(); say(s ? `${s.url}\n会话 ${s.conversation_id}${s.project_id ? `，项目 ${s.project_id}` : ''}` : '未设置'); return; }
    if (sub === 'clear') { setChatgptWeb({ session_url: null, conversation_id: null, project_id: null }); say('已清除固定会话（搜索将报 chatgpt_web_no_session）。'); return; }
    if (sub === 'set' && url) {
      try { const r = await web.setSession(url); say(`已保存固定会话：「${r.title}」\n会话 ${r.conversation_id}${r.project_id ? `，项目 ${r.project_id}` : ''}\n存放位置：${CONFIG_FILE}\n下一步：subpow web on`); }
      catch (e) { say(`未保存：${e.code ?? ''} ${e.message}`); process.exitCode = 1; }
      return;
    }
    say('用法：subpow web session set <网址> | show | clear'); process.exitCode = 2; return;
  }
  if (cmd === 'off') { setChatgptWeb({ enabled: false }); say('已关闭固定网页会话搜索。'); return; }
  if (cmd === 'reset') { setChatgptWeb({ tripped: false, tripped_reason: null, consecutive_failures: 0 }); say('已清除熔断状态。'); return; }
  if (cmd === 'check') { const r = await web.check(); say(JSON.stringify(r, null, 1)); process.exitCode = r.ok ? 0 : 1; return; }
  if (cmd === 'on') {
    if (!flag('force')) {
      const r = await web.check();
      if (!r.ok) { say(`拒绝开启：${r.code}: ${r.message}\n（确认无误可加 --force）`); process.exitCode = 1; return; }
      say(`检查通过：会话「${r.title}」可读；桥接 ${r.bridge_ok ? '可用' : '不可用'}；页面${r.tab_open ? '已在 Chrome 中打开' : '尚未在 Chrome 中打开（搜索前需要打开并保持可见）'}`);
    }
    setChatgptWeb({ enabled: true, tripped: false, tripped_reason: null, consecutive_failures: 0 });
    say('已开启固定网页会话搜索。运行中的 MCP 会在 2 秒内显示 chatgpt_web_search。');
    return;
  }
  if (cmd === 'search') {
    const q = rest.find((x) => !x.startsWith('--') && x !== opt('mode') && x !== opt('n'));
    if (!q) { say('用法：subpow web search "<query>" [--mode deep]'); process.exitCode = 2; return; }
    const r = await web.webSearch({ query: q, mode: opt('mode'), max_results: opt('n') ? Number(opt('n')) : undefined }, { force: flag('force') });
    say(JSON.stringify(r, null, 1)); process.exitCode = r.ok ? 0 : 1;
    return;
  }
  say(`未知命令：web ${cmd}（subpow help）`); process.exitCode = 2;
}

async function searchMain() {
  if (cmd === 'status') {
    say(`顺序: ${getSearchOrder().join(' → ')}`);
    for (const [name, b] of Object.entries(search.REGISTRY)) { const why = b.available(); say(`  ${name.padEnd(12)} ${why ? `跳过 — ${why}` : '可用'}`); }
    return;
  }
  if (cmd === 'order') {
    const order = (rest[0] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!order.length || !order.every((x) => SEARCH_BACKENDS.includes(x))) { say(`用法：subpow search order <${SEARCH_BACKENDS.join(',')} 的任意排列，逗号分隔>`); process.exitCode = 2; return; }
    setSearchOrder(order); say(`顺序已改为：${order.join(' → ')}`); return;
  }
  if (cmd === 'run') {
    const q = rest.find((x) => !x.startsWith('--') && ![opt('mode'), opt('n'), opt('backends')].includes(x));
    if (!q) { say('用法：subpow search run "<query>" [--mode deep] [--backends codex_api,codex_cli]'); process.exitCode = 2; return; }
    const r = await search.webSearch({ query: q, mode: opt('mode'), max_results: opt('n') ? Number(opt('n')) : undefined, backends: opt('backends')?.split(',') });
    say(JSON.stringify(r, null, 1)); process.exitCode = r.ok ? 0 : 1;
    return;
  }
  say(`未知命令：search ${cmd}（subpow help）`); process.exitCode = 2;
}

async function main() {
  if (!area || !cmd || area === 'help' || cmd === 'help') { say(HELP); return; }
  if (area === 'dot') return dotMain();
  if (area === 'codex') return codexMain();
  if (area === 'web') return webMain();
  if (area === 'search') return searchMain();
  say(`未知命令：${area}（subpow help）`); process.exitCode = 2;
}
main().catch((e) => { console.error(`出错：${e.code ?? ''} ${e.message}`); process.exit(1); });
