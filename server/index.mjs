#!/usr/bin/env node
/**
 * subscription-powers —— 把 Codex（ChatGPT 订阅）与 Claude Code（Team 订阅）独有的能力封装成 MCP。
 * 只起官方 CLI 子进程（codex exec / claude -p），不读不改任何凭据；子进程强制使用个人 HOME。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as codex from './lib/codex.mjs';
import * as claude from './lib/claude.mjs';

const server = new McpServer({ name: 'subscription-powers', version: '0.1.0' });
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError: obj?.ok === false });
// 长任务（生图 30–90 s）会撞上客户端默认 60 s 的请求超时：拿到 progressToken 时每 8 s 发一次 notifications/progress 心跳，
// 支持 resetTimeoutOnProgress 的客户端（Claude Code / MCP SDK client）会据此续期。
const guard = (fn) => async (args, extra) => {
  const token = extra?._meta?.progressToken; let tick = 0;
  const beat = token !== undefined && extra?.sendNotification
    ? setInterval(() => { tick++; extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: tick, message: `working… ${tick * 8}s` } }).catch(() => {}); }, 8000)
    : null;
  try { return text(await fn(args)); }
  catch (e) { return text({ ok: false, code: 'invalid_input', message: e.message }); }
  finally { if (beat) clearInterval(beat); }
};

server.registerTool('codex_generate_image', {
  title: 'Generate image (Codex / gpt-image-2, ChatGPT subscription)',
  description: 'Generate a raster image (PNG) with OpenAI gpt-image-2 through the Codex CLI, billed to the ChatGPT subscription. Use ONLY when a real bitmap is needed (photo, illustration, texture, mockup, transparent cutout) — not for icons/diagrams that can be SVG/HTML. Slow (30–90 s) and quota-heavy (~3–5× a text turn); one call per image.',
  inputSchema: {
    prompt: z.string().min(3).describe('What to draw. Be concrete: subject, composition, lighting, palette, mood.'),
    out_dir: z.string().describe('Absolute directory to save the PNG into (created if missing).'),
    filename: z.string().optional().describe('File name (.png). Default: slug of prompt + short id.'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional().describe('Default 1024x1024. 1536x1024 landscape, 1024x1536 portrait.'),
    background: z.enum(['auto', 'transparent', 'opaque']).optional().describe('transparent → PNG with alpha (cutouts, sprites).'),
    style: z.string().optional().describe('Optional style guidance, e.g. "flat vector", "photoreal", "hand-drawn sketch".'),
    reference_image: z.string().optional().describe('Absolute path of a reference image to guide the look.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard(codex.generateImage));

server.registerTool('codex_edit_image', {
  title: 'Edit image (Codex / gpt-image-2)',
  description: 'Edit an existing image with a natural-language instruction (change background, remove/add objects, restyle, make transparent). Optional mask: transparent areas are redrawn. Output is a new PNG next to the source unless out_path is given.',
  inputSchema: {
    image_path: z.string().describe('Absolute path of the source image.'),
    instruction: z.string().min(3),
    out_path: z.string().optional().describe('Absolute output path (.png). Default: <source>-edited-<id>.png'),
    mask_path: z.string().optional(),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard(codex.editImage));

server.registerTool('codex_web_search', {
  title: 'Web search via Codex (OpenAI native web_search, ChatGPT subscription)',
  description: 'Live web research using OpenAI\'s native web_search tool inside Codex (GPT-6 class model). Returns a concise answer plus source URLs. Good for English/tech topics and very recent events. Not available on the company relay — this is the subscription-only path.',
  inputSchema: {
    query: z.string().min(2).describe('The research question, in any language.'),
    max_results: z.number().int().min(1).max(10).optional().describe('How many sources to list (default 5).'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard(codex.webSearch));

server.registerTool('claude_web_search', {
  title: 'Web search via Claude Code (Anthropic WebSearch + WebFetch, Team subscription)',
  description: 'Live web research using Claude Code\'s built-in WebSearch (and WebFetch to read pages). Returns a concise answer plus source URLs and the list-price cost. Independent from the Codex path — use both when cross-checking matters.',
  inputSchema: {
    query: z.string().min(2),
    max_results: z.number().int().min(1).max(10).optional(),
    recency: z.string().optional(),
    allow_fetch: z.boolean().optional().describe('Allow WebFetch to open result pages (default true).'),
    model: z.string().optional().describe('Claude model alias/id, e.g. "opus", "sonnet". Default: personal config default.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard(claude.webSearch));

server.registerTool('claude_web_fetch', {
  title: 'Fetch & read a URL via Claude Code WebFetch',
  description: 'Fetch one URL with Claude Code\'s WebFetch (server-side fetch, 15-min cache, handles JS-light pages) and answer a question about it or summarize it. Cheaper than a search.',
  inputSchema: {
    url: z.string().url(),
    prompt: z.string().optional().describe('What to extract/answer from the page. Default: faithful summary.'),
    model: z.string().optional(),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard(claude.webFetch));

server.registerTool('codex_run', {
  title: 'Run a task with Codex (GPT-6 class, ChatGPT subscription)',
  description: 'Fallback: run an arbitrary agent task with the subscription Codex (default read-only sandbox). Useful when the company relay is down or when GPT-6 subscription behaviour is specifically wanted. Returns the final message and token usage.',
  inputSchema: {
    prompt: z.string().min(3),
    cwd: z.string().optional().describe('Absolute working directory (default: empty temp dir).'),
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    web_search: z.boolean().optional().describe('Enable native web_search for this run.'),
    model: z.string().optional().describe('e.g. gpt-6-astra, gpt-5.6-sol'),
    timeout_ms: z.number().int().min(30_000).max(1_800_000).optional(),
  },
}, guard(codex.runTask));

server.registerTool('claude_run', {
  title: 'Run a task with Claude Code (Team subscription)',
  description: 'Fallback: run an arbitrary task with the subscription Claude Code (read-only tools by default; set allow_edits for file changes). Returns the final answer, turns and list-price cost.',
  inputSchema: {
    prompt: z.string().min(3),
    cwd: z.string().optional(),
    allowed_tools: z.array(z.string()).optional().describe('Default: Read, Glob, Grep, WebSearch, WebFetch'),
    allow_edits: z.boolean().optional().describe('true → --dangerously-skip-permissions (all tools). Use with care.'),
    model: z.string().optional(),
    timeout_ms: z.number().int().min(30_000).max(1_800_000).optional(),
  },
}, guard(claude.runTask));

await server.connect(new StdioServerTransport());
