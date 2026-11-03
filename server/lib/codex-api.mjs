/**
 * Codex 直连搜索：不起 `codex` 子进程，直接请求 chatgpt.com/backend-api/codex/responses，
 * 用 OpenAI 托管的 web_search 工具（tool_choice 强制搜索），来源取自结构化事件。
 * Adapted from can1357/oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/codex.ts
 * 版权：Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.（许可全文见 THIRD_PARTY_NOTICES.md）
 */
import { CodexApiError, CODEX_BASE_URL, resolveResponsesUrl, buildHeaders, clientVersion, extractSseError, statusFromText } from './codex-wire.mjs';
import { readCodexAuth } from './codex-auth.mjs';
import { getCodexApi, setCodexApi } from './store.mjs';
import { cleanUrl, extractLinks, stripTracking } from './links.mjs';

// 搜索档位。模型 ID 来自本机 Codex 的模型列表（~/.codex/models_cache.json）
export const MODES = {
  quick: { model: 'gpt-6-luna', effort: 'low', context: 'medium' },
  deep: { model: 'gpt-6.1-sol', effort: 'medium', context: 'high' },
};
// 计入熔断的失败：令牌被拒（含区域/套餐不允许）、被 Cloudflare 拦。网络、限流、5xx、令牌过期、无凭据都不计
const COUNTED = new Set(['codex_api_unauthorized', 'codex_api_blocked']);
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

const QUICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'url', 'summary'], properties: { title: { type: 'string' }, url: { type: 'string' }, summary: { type: 'string' } } } } },
};

// ───────── 纯函数（有单测）─────────
/** SSE 读取：按空行切帧，兼容 CRLF 与多行 data: */
export async function* readSse(body) {
  const dec = new TextDecoder(); let buf = '';
  const frameToEvent = (frame) => {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
  };
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    for (let m; (m = buf.match(/\r?\n\r?\n/)); ) {
      const ev = frameToEvent(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length);
      if (ev) yield ev;
    }
  }
  buf += dec.decode();
  if (buf.trim()) { const ev = frameToEvent(buf); if (ev) yield ev; }
}

export function buildBody(mode, a, n, m) {
  const recency = a.recency ? ` Prefer sources from the last ${a.recency}.` : '';
  const body = {
    model: m.model, stream: true, store: false, include: ['web_search_call.action.sources'], parallel_tool_calls: true,
    reasoning: { effort: m.effort },
    tools: [{ type: 'web_search', search_context_size: m.context }],
    tool_choice: { type: 'web_search' },
  };
  if (mode === 'quick') {
    body.instructions = `You are the web-search backend of a tool. Search the web once, then output ONLY the JSON required by the schema: up to ${n} distinct, relevant pages (prefer different sites), each with the page title, its full URL, and one sentence (in the language of the query) saying what that page says.${recency} No commentary.`;
    body.text = { format: { type: 'json_schema', name: 'search_results', strict: true, schema: QUICK_SCHEMA } };
  } else {
    body.instructions = `You are a research assistant with web search. Search as needed and cross-check sources. Answer concisely and factually in the language of the question, and cite your sources.${recency}`;
  }
  body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: a.query.trim() }] }];
  return body;
}

const urlOf = (s) => s?.url ?? s?.source_website_url;
/** 逐条处理 SSE 事件，收集答案、来源（工具事件里的结构化来源 + 答案里的引用注解）、用量 */
export async function consume(events) {
  const st = { invoked: false, answerParts: [], streamed: '', toolSources: [], citations: new Map(), queries: [], model: undefined, requestId: undefined, usage: undefined };
  const addTool = (u) => { if (u) { const c = cleanUrl(u); if (!st.toolSources.includes(c)) st.toolSources.push(c); } };
  for await (const e of events) {
    const type = e.type ?? '';
    if (type.startsWith('response.web_search_call')) st.invoked = true;
    if (type === 'response.created') { st.requestId = e.response?.id ?? st.requestId; st.model = e.response?.model ?? st.model; }
    else if (type === 'response.output_text.delta') st.streamed += e.delta ?? '';
    else if (type === 'response.output_item.done') {
      const it = e.item ?? {};
      if (it.type === 'web_search_call') {
        st.invoked = true;
        const q = it.action?.query ?? it.action?.queries?.join(' | '); if (q) st.queries.push(q);
        for (const g of [it.action?.sources, it.sources, it.results]) for (const s of g ?? []) addTool(urlOf(s));
      } else if (it.type === 'message') {
        for (const p of it.content ?? []) {
          if (p.type !== 'output_text' || !p.text) continue;
          st.answerParts.push(p.text);
          for (const an of p.annotations ?? []) if (an.type === 'url_citation' && an.url) { const u = cleanUrl(an.url); if (!st.citations.has(u)) st.citations.set(u, { title: an.title || u, url: u }); }
        }
      }
    } else if (type === 'response.completed' || type === 'response.done') {
      const r = e.response ?? {};
      st.model = r.model ?? st.model; st.requestId = r.id ?? st.requestId;
      if (r.usage) st.usage = { input_tokens: r.usage.input_tokens, cached_input_tokens: r.usage.input_tokens_details?.cached_tokens, output_tokens: r.usage.output_tokens, reasoning_output_tokens: r.usage.output_tokens_details?.reasoning_tokens };
    } else if (type === 'error' || type === 'response.failed') {
      const { code, message } = extractSseError(e);
      throw sseError(code, message);
    }
  }
  return st;
}
function sseError(code, message) {
  const status = statusFromText(code, message);
  const text = `${code ? `(${code}) ` : ''}${message || 'request failed'}`.slice(0, 300);
  if (status === 429) return new CodexApiError('codex_api_rate_limited', text);
  if (status === 401 || status === 403) return new CodexApiError('codex_api_unauthorized', text);
  return new CodexApiError('codex_api_server', text, { retryable: true });
}
const snippet = (t) => String(t).replace(/\s+/g, ' ').slice(0, 220);
function httpError(r, text) {
  if (r.headers.get('cf-mitigated') === 'challenge' || /^\s*<(!doctype|html)/i.test(text)) return new CodexApiError('codex_api_blocked', `Cloudflare challenge (HTTP ${r.status})`);
  if (r.status === 401 || r.status === 403) return new CodexApiError('codex_api_unauthorized', `HTTP ${r.status}: ${snippet(text)}`);
  if (r.status === 429) { const ra = Number(r.headers.get('retry-after')); return new CodexApiError('codex_api_rate_limited', `HTTP 429: ${snippet(text)}`, { retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined }); }
  if (r.status >= 500) return new CodexApiError('codex_api_server', `HTTP ${r.status}: ${snippet(text)}`, { retryable: true });
  return new CodexApiError('codex_api_bad_request', `HTTP ${r.status}: ${snippet(text)}`);
}

/** 解析 quick 档位的 JSON（text.format 已强制；仍兜底处理代码块），清洗并去重 */
export function parseResults(text, n) {
  let arr;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { const j = JSON.parse((fence ? fence[1] : text).trim()); arr = Array.isArray(j) ? j : j.results; } catch {}
  const seen = new Set();
  return (arr ?? []).filter((x) => x && /^https?:\/\//i.test(x.url ?? '')).map((x) => ({ title: String(x.title ?? x.url).trim(), url: cleanUrl(x.url), summary: String(x.summary ?? '').trim() }))
    .filter((x) => !seen.has(x.url) && seen.add(x.url)).slice(0, n);
}

// ───────── 并发限制（进程内）─────────
let active = 0, lastStart = 0; const waiters = [];
async function acquire(max, gapMs, sleep) {
  const t0 = Date.now();
  while (active >= max) await new Promise((r) => waiters.push(r));
  active++;
  const wait = Math.max(0, lastStart + gapMs - Date.now()); lastStart = Date.now() + wait;
  if (wait) await sleep(wait);
  return Date.now() - t0;
}
const release = () => { active--; waiters.shift()?.(); };

// ───────── 熔断 ─────────
function note(err) {
  const c = getCodexApi();
  if (!err) { if (c.consecutive_failures) setCodexApi({ consecutive_failures: 0 }); return; }
  if (!COUNTED.has(err.code)) return;
  const n = c.consecutive_failures + 1;
  setCodexApi(n >= c.trip_after ? { consecutive_failures: n, tripped: true, tripped_reason: `${err.code}: ${err.message}` } : { consecutive_failures: n });
}
/** 套餐 / 账号和开启时记录的不一致（套餐到期、换号）→ 立即熔断，不等失败累积 */
function bindingProblem(auth, c) {
  if (c.bound_plan && auth.plan && auth.plan !== c.bound_plan) return `plan_changed: ${c.bound_plan} → ${auth.plan}`;
  if (c.bound_account && auth.accountId !== c.bound_account) return 'account_changed: the Codex login now belongs to a different ChatGPT account';
  return null;
}

// ───────── 一次请求（含重试）─────────
async function callOnce({ url, headers, body, timeoutMs, fetchImpl }) {
  let r;
  try { r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new CodexApiError('codex_api_network', e.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(e.cause?.code ?? e.message), { retryable: true }); }
  if (!r.ok) throw httpError(r, await r.text().catch(() => ''));
  if (!r.body) throw new CodexApiError('codex_api_server', 'empty response body', { retryable: true });
  try { return await consume(readSse(r.body)); }
  catch (e) { if (e instanceof CodexApiError) throw e; throw new CodexApiError('codex_api_network', e.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `stream interrupted: ${e.message}`, { retryable: true }); }
}
const RATE_BUDGET_MS = 120_000;
async function withRetry(fn, sleep) {
  let tries = 0, waited = 0;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof CodexApiError) || tries >= 2) throw e;
      let delay;
      if (e.retryable) delay = 1000 * 2 ** tries;
      else if (e.code === 'codex_api_rate_limited' && e.retryAfterMs !== undefined && waited + e.retryAfterMs <= RATE_BUDGET_MS) delay = e.retryAfterMs;
      else throw e;
      tries++; waited += delay; await sleep(delay);
    }
  }
}

/**
 * 搜索入口。opts 仅供测试：{ fetchImpl, sleep }
 * 返回结构与 codex_web_search / dot_web_search 一致：quick → results[]，deep → answer + sources[]
 */
export async function webSearch(a, { fetchImpl = fetch, sleep = sleepReal } = {}) {
  const cfg = getCodexApi();
  if (!cfg.enabled) return { ok: false, backend: 'codex_api', code: 'codex_api_disabled', message: 'Codex direct-API search is switched off (enable: node server/bin/subpow.mjs codex on). Use codex_web_search instead.' };
  if (cfg.tripped) return { ok: false, backend: 'codex_api', code: 'codex_api_disabled', message: `Codex direct-API search was auto-disabled (${cfg.tripped_reason}). Fix it, then run: node server/bin/subpow.mjs codex reset. Use codex_web_search instead.` };
  const mode = a.mode ?? 'quick';
  const m = { ...MODES[mode], ...(a.model && { model: a.model }), ...(a.effort && { effort: a.effort }) };
  const n = a.max_results ?? (mode === 'quick' ? 10 : 5);
  const t0 = Date.now(); let queued_ms = 0, held = false;
  const fail = (e) => ({ ok: false, backend: 'codex_api', mode, model: m.model, effort: m.effort, code: e.code, message: e.message, queued_ms, elapsed_ms: Date.now() - t0 });
  try {
    const auth = readCodexAuth();
    const problem = bindingProblem(auth, cfg);
    if (problem) { setCodexApi({ tripped: true, tripped_reason: problem }); return { ok: false, backend: 'codex_api', code: 'codex_api_disabled', message: `Codex direct-API search was auto-disabled (${problem}). Run: node server/bin/subpow.mjs codex on` }; }
    const version = await clientVersion();
    queued_ms = await acquire(cfg.concurrency, cfg.min_interval_ms, sleep); held = true;
    const st = await withRetry(() => callOnce({ url: resolveResponsesUrl(CODEX_BASE_URL), headers: buildHeaders({ ...auth, version }), body: buildBody(mode, a, n, m), timeoutMs: a.timeout_ms ?? cfg.timeout_ms, fetchImpl }), sleep);
    if (!st.invoked) throw new CodexApiError('codex_api_no_search', 'Codex answered without running web search (no web_search_call event); refusing to return it as a search result');
    note(null);
    const warnings = [];
    const text = (st.answerParts.join('\n\n') || st.streamed).trim();
    const base = { ok: true, backend: 'codex_api', mode, model: st.model ?? m.model, effort: m.effort, searches_made: st.queries, usage: st.usage, request_id: st.requestId, queued_ms, elapsed_ms: Date.now() - t0 };
    if (mode === 'quick') {
      let results = parseResults(text, n);
      if (!results.length) {   // 模型没按 schema 输出：退而求其次，用引用注解和工具事件里的来源
        warnings.push('model returned no parsable results; falling back to cited / consulted sources');
        results = [...st.citations.values(), ...st.toolSources.filter((u) => !st.citations.has(u)).map((u) => ({ title: u, url: u }))].map((x) => ({ ...x, summary: '' })).slice(0, n);
      }
      if (!results.length) throw new CodexApiError('codex_api_bad_output', `no results in the reply: ${snippet(text)}`);
      const have = new Set(results.map((x) => x.url));
      return { ...base, results, other_sources: st.toolSources.filter((u) => !have.has(u)).slice(0, 20), warnings: warnings.length ? warnings : undefined };
    }
    if (!text && !st.toolSources.length) throw new CodexApiError('codex_api_bad_output', 'empty answer');
    const answer = stripTracking(text);
    const sources = [...new Set([...st.citations.keys(), ...extractLinks(answer).map((l) => l.url), ...st.toolSources])].slice(0, Math.max(n, st.citations.size));
    return { ...base, answer, sources, citations: [...st.citations.values()].slice(0, 20) };
  } catch (e) {
    if (!(e instanceof CodexApiError)) throw e;
    note(e);
    return fail(e);
  } finally { if (held) release(); }
}

/** 健康检查：读取令牌并核对套餐 / 账号，不发请求，不消耗额度 */
export function check() {
  try {
    const a = readCodexAuth();
    return { ok: true, plan: a.plan, account_id: `${a.accountId.slice(0, 8)}…`, token_expires: new Date(a.exp).toISOString(), last_refresh: a.lastRefresh, residency: a.residency ?? null };
  } catch (e) { return { ok: false, code: e.code ?? 'error', message: e.message }; }
}
