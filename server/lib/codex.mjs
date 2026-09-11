import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { run, classify } from './run.mjs';
import { cleanEnv } from './env.mjs';
import { serial } from './queue.mjs';
import { assertSafeAbs, ensureDir, exists, newestImage, slug } from './paths.mjs';

const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

/** 解析 `codex exec --json` 的事件流 */
function parseEvents(stdout) {
  const messages = [], searches = [], errors = [], commands = []; let usage = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const it = e.item ?? {};
    if (e.type === 'item.completed' && it.type === 'agent_message' && it.text) messages.push(it.text);
    if (e.type === 'item.completed' && it.type === 'web_search' && it.query) searches.push(it.query);
    if (e.type === 'item.completed' && it.type === 'command_execution') commands.push((it.command || '').slice(0, 200));
    if (e.type === 'error') errors.push(e.message ?? JSON.stringify(e).slice(0, 300));
    if (e.type === 'turn.completed' && e.usage) usage = e.usage;
  }
  return { messages, searches, errors, commands, usage, final: messages.at(-1) ?? '' };
}

async function codexExec({ prompt, cwd, sandbox = 'read-only', search = false, attach = [], timeoutMs, model }) {
  const lastMsg = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-')), 'last.txt');
  const args = [];
  if (search) args.push('--search');               // 全局参数，必须在 exec 之前
  if (model) args.push('-m', model);
  args.push('exec', '--skip-git-repo-check', '-s', sandbox, '--cd', cwd, '--json', '--output-last-message', lastMsg, '--color', 'never');
  for (const img of attach) args.push('-i', img);
  args.push(prompt);
  const o = await run('codex', args, { cwd, env: cleanEnv(), timeoutMs });
  const ev = parseEvents(o.stdout);
  const last = await fs.readFile(lastMsg, 'utf8').catch(() => '');
  fs.rm(path.dirname(lastMsg), { recursive: true, force: true }).catch(() => {});
  return { ...o, ev, last: last.trim() || ev.final };
}

const usageOut = (u) => u && { input_tokens: u.input_tokens, cached_input_tokens: u.cached_input_tokens, output_tokens: u.output_tokens, reasoning_output_tokens: u.reasoning_output_tokens };

export async function generateImage(a) {
  return serial('codex', async () => {
    const outDir = await ensureDir(assertSafeAbs(a.out_dir, 'out_dir'));
    const name = (a.filename || `${slug(a.prompt)}-${Date.now().toString(36)}.png`).replace(/\.(jpe?g|webp)$/i, '.png');
    const outPath = path.join(outDir, name.endsWith('.png') ? name : `${name}.png`);
    const size = SIZES.has(a.size) ? a.size : '1024x1024';
    const ref = a.reference_image ? assertSafeAbs(a.reference_image, 'reference_image') : null;
    const lines = [
      `@imagegen ${a.prompt.trim()}`, '',
      'Use the built-in image_gen tool (not the OpenAI API CLI fallback). Do not run shell commands except what is needed to save the file.',
      `Size: ${size}.`,
      a.background === 'transparent' ? 'Background must be fully transparent (alpha channel), output PNG.' : a.background === 'opaque' ? 'Background fully opaque.' : '',
      a.style ? `Style guidance: ${a.style}` : '',
      ref ? `A reference image is attached (${ref}); use it for visual guidance.` : '',
      '', `Save the generated image to exactly this absolute path: ${outPath}`,
      'After saving, reply with only one line in the form:', `SAVED ${outPath}`,
    ].filter((l) => l !== '');
    const started = Date.now();
    const o = await codexExec({ prompt: lines.join('\n'), cwd: outDir, sandbox: 'workspace-write', attach: ref ? [ref] : [], timeoutMs: a.timeout_ms ?? 240_000 });
    let saved = (o.last.match(/^SAVED\s+(.+)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    if (!saved || !(await exists(saved))) saved = (await exists(outPath)) ? outPath : await newestImage(outDir, started);
    if (!saved) { const err = classify(o, 'codex') ?? { code: 'no_image_saved', message: 'Codex finished but no image file was found' }; return { ok: false, ...err, last_message: o.last.slice(0, 500), errors: o.ev.errors, stderr_tail: o.stderrTail.slice(-1500), elapsed_ms: o.elapsedMs }; }
    return { ok: true, path: saved, size, elapsed_ms: o.elapsedMs, usage: usageOut(o.ev.usage), note: o.ev.errors.length ? o.ev.errors.join(' | ').slice(0, 300) : undefined };
  });
}

export async function editImage(a) {
  return serial('codex', async () => {
    const src = assertSafeAbs(a.image_path, 'image_path');
    if (!(await exists(src))) return { ok: false, code: 'invalid_input', message: `image_path not found: ${src}` };
    const outPath = a.out_path ? assertSafeAbs(a.out_path, 'out_path') : src.replace(/(\.[a-z]+)?$/i, `-edited-${Date.now().toString(36)}.png`);
    await ensureDir(path.dirname(outPath));
    const mask = a.mask_path ? assertSafeAbs(a.mask_path, 'mask_path') : null;
    const lines = [
      `@imagegen Edit the attached image: ${a.instruction.trim()}`, '',
      `Source image: ${src} (attached).`,
      mask ? `Edit mask: ${mask} (attached) — transparent areas are to be redrawn, opaque areas preserved.` : '',
      'Use the built-in image_gen edit capability, not the OpenAI API CLI fallback. Preserve the overall composition unless told otherwise.',
      '', `Save the edited image to exactly this absolute path: ${outPath}`,
      'After saving, reply with only one line in the form:', `SAVED ${outPath}`,
    ].filter((l) => l !== '');
    const started = Date.now();
    const o = await codexExec({ prompt: lines.join('\n'), cwd: path.dirname(outPath), sandbox: 'workspace-write', attach: [src, ...(mask ? [mask] : [])], timeoutMs: a.timeout_ms ?? 240_000 });
    let saved = (o.last.match(/^SAVED\s+(.+)$/m)?.[1] ?? '').trim();
    if (!saved || !(await exists(saved))) saved = (await exists(outPath)) ? outPath : await newestImage(path.dirname(outPath), started);
    if (!saved) { const err = classify(o, 'codex') ?? { code: 'no_image_saved', message: 'Codex finished but no edited image was found' }; return { ok: false, ...err, last_message: o.last.slice(0, 500), stderr_tail: o.stderrTail.slice(-1500), elapsed_ms: o.elapsedMs }; }
    return { ok: true, path: saved, source: src, elapsed_ms: o.elapsedMs, usage: usageOut(o.ev.usage) };
  });
}

export async function webSearch(a) {
  return serial('codex', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-search-'));
    const n = a.max_results ?? 5;
    const prompt = [
      `Research question: ${a.query.trim()}`,
      a.recency ? `Prefer sources from the last ${a.recency}.` : '',
      `Use ONLY the built-in web_search tool to look this up (do not run shell commands, do not read skills, do not use gh). Do at most ${Math.max(2, Math.ceil(n / 2))} searches.`,
      `Answer concisely in the language of the question. Then list up to ${n} sources as markdown bullet links with full URLs under a heading "Sources".`,
    ].filter(Boolean).join('\n');
    const o = await codexExec({ prompt, cwd, sandbox: 'read-only', search: true, timeoutMs: a.timeout_ms ?? 180_000 });
    fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    const err = classify(o, 'codex');
    if (err && !o.last) return { ok: false, ...err, errors: o.ev.errors, stderr_tail: o.stderrTail.slice(-1500) };
    const sources = [...new Set((o.last.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, '')))];
    return { ok: true, answer: o.last, sources, searches_made: o.ev.searches, shell_commands_used: o.ev.commands.length, elapsed_ms: o.elapsedMs, usage: usageOut(o.ev.usage), warnings: o.ev.errors.length ? o.ev.errors : undefined };
  });
}

export async function runTask(a) {
  return serial('codex', async () => {
    const cwd = a.cwd ? assertSafeAbs(a.cwd, 'cwd') : await fs.mkdtemp(path.join(os.tmpdir(), 'subpow-run-'));
    const o = await codexExec({ prompt: a.prompt, cwd, sandbox: a.sandbox ?? 'read-only', search: !!a.web_search, model: a.model, timeoutMs: a.timeout_ms ?? 600_000 });
    const err = classify(o, 'codex');
    if (err && !o.last) return { ok: false, ...err, errors: o.ev.errors, stderr_tail: o.stderrTail.slice(-1500) };
    return { ok: true, answer: o.last, cwd, commands_run: o.ev.commands.length, elapsed_ms: o.elapsedMs, usage: usageOut(o.ev.usage), warnings: o.ev.errors.length ? o.ev.errors : undefined };
  });
}
