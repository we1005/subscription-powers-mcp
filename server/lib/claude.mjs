import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { run, classify } from './run.mjs';
import { cleanEnv } from './env.mjs';
import { serial } from './queue.mjs';
import { assertSafeAbs } from './paths.mjs';

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

/** claude -p … --output-format json；解析结果 JSON */
async function claudeP({ prompt, cwd, allowedTools, model, extraArgs = [], timeoutMs }) {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  if (model) args.push('--model', model);
  args.push(...extraArgs);
  const o = await run('claude', args, { cwd, env: cleanEnv(), timeoutMs });
  let res = null;
  const start = o.stdout.indexOf('{'); const end = o.stdout.lastIndexOf('}');
  if (start >= 0 && end > start) { try { res = JSON.parse(o.stdout.slice(start, end + 1)); } catch {} }
  return { ...o, res };
}
const meta = (r) => r && { cost_usd_list_price: r.total_cost_usd, turns: r.num_turns, duration_ms: r.duration_ms, models: Object.keys(r.modelUsage ?? {}), session_id: r.session_id };

export async function webSearch(a) {
  return serial('claude', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-claude-'));
    const n = a.max_results ?? 5;
    const tools = a.allow_fetch === false ? ['WebSearch'] : ['WebSearch', 'WebFetch'];
    const prompt = [
      `Research question: ${a.query.trim()}`,
      a.recency ? `Prefer sources from the last ${a.recency}.` : '',
      `Use the WebSearch tool${tools.length > 1 ? ' (and WebFetch to read a page when needed)' : ''}. Do not use any other tool.`,
      `Answer concisely in the language of the question, then list up to ${n} sources as markdown bullet links with full URLs under a heading "Sources".`,
    ].filter(Boolean).join('\n');
    const o = await claudeP({ prompt, cwd, allowedTools: tools, model: a.model, timeoutMs: a.timeout_ms ?? 180_000 });
    fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (!o.res || o.res.is_error) { const err = classify(o, 'claude') ?? { code: 'claude_error', message: o.res?.result ?? 'no result' }; return { ok: false, ...err, result: o.res?.result, stderr_tail: o.stderrTail.slice(-1500) }; }
    const answer = o.res.result ?? '';
    return { ok: true, answer, sources: [...new Set((answer.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, '')))], elapsed_ms: o.elapsedMs, ...meta(o.res) };
  });
}

export async function webFetch(a) {
  return serial('claude', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-claude-'));
    const prompt = `Use the WebFetch tool to fetch ${a.url} and then: ${a.prompt?.trim() || 'summarize the page faithfully, keeping key facts, numbers and names.'}\nDo not use any other tool. Reply with the answer only.`;
    const o = await claudeP({ prompt, cwd, allowedTools: ['WebFetch'], model: a.model, timeoutMs: a.timeout_ms ?? 150_000 });
    fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (!o.res || o.res.is_error) { const err = classify(o, 'claude') ?? { code: 'claude_error', message: o.res?.result ?? 'no result' }; return { ok: false, ...err, result: o.res?.result, stderr_tail: o.stderrTail.slice(-1500) }; }
    return { ok: true, url: a.url, answer: o.res.result ?? '', elapsed_ms: o.elapsedMs, ...meta(o.res) };
  });
}

export async function runTask(a) {
  return serial('claude', async () => {
    const cwd = a.cwd ? assertSafeAbs(a.cwd, 'cwd') : await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-claude-run-'));
    const tools = a.allowed_tools?.length ? a.allowed_tools : ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    const extra = a.allow_edits ? ['--dangerously-skip-permissions'] : [];
    const o = await claudeP({ prompt: a.prompt, cwd, allowedTools: a.allow_edits ? undefined : tools, model: a.model, extraArgs: extra, timeoutMs: a.timeout_ms ?? 600_000 });
    if (!o.res || o.res.is_error) { const err = classify(o, 'claude') ?? { code: 'claude_error', message: o.res?.result ?? 'no result' }; return { ok: false, ...err, result: o.res?.result, stderr_tail: o.stderrTail.slice(-1500) }; }
    return { ok: true, answer: o.res.result ?? '', cwd, elapsed_ms: o.elapsedMs, ...meta(o.res) };
  });
}
