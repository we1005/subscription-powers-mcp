#!/usr/bin/env node
/**
 * subscription-powers —— 把 Codex（ChatGPT 订阅）与 Claude Code（Team 订阅）独有的能力封装成 MCP。
 * 主体：起官方 CLI 子进程（codex exec / claude -p），不读不改任何凭据；子进程强制使用个人 HOME。
 * 实验性后端（默认关闭，可热开关）：dot_web_search（Dot 消息接口）、codex_api_search（Codex Responses 接口，
 * 只读借用 ~/.codex/auth.json 的令牌，从不刷新或写回）。统一入口 web_search 按顺序尝试各后端。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as codex from './lib/codex.mjs';
import * as claude from './lib/claude.mjs';
import { logCall } from './lib/log.mjs';
import fs from 'node:fs';
import * as dot from './lib/dot.mjs';
import * as codexApi from './lib/codex-api.mjs';
import * as chatgptWeb from './lib/chatgpt-web.mjs';
import * as search from './lib/search.mjs';
import { dotActive, codexApiActive, chatgptWebActive, CONFIG_FILE, SEARCH_BACKENDS } from './lib/store.mjs';

// 写给模型看的使用说明：Codex 会把它作为 MCP 命名空间说明、Claude Code 会放进系统提示。
// 作用是让模型"一开始就知道"该用哪个工具，而不是等到想起来。保持短、指令式；不提具体后端（开关会变）。
const INSTRUCTIONS = [
  'subscription-powers gives you live web search and image generation backed by the user\'s subscriptions.',
  '- For ANY question that needs current, recent or verifiable online information (versions, releases, news, docs, prices, "latest", anything after your training data), call `web_search` BEFORE answering from memory. Do not say you cannot browse. Use mode "deep" for questions that need a researched answer, "quick" for a list of sources.',
  '- If a built-in web search tool exists and works, either is fine; if it is missing or fails, use `web_search`.',
  '- For a raster image (photo, illustration, texture, mockup), call `codex_generate_image`; to modify an existing image, call `codex_edit_image`.',
].join('\n');
const server = new McpServer({ name: 'subscription-powers', version: '0.1.0' }, { instructions: INSTRUCTIONS });
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError: obj?.ok === false });
// 长任务（生图 30–90 s）会撞上客户端默认 60 s 的请求超时：拿到 progressToken 时每 8 s 发一次 notifications/progress 心跳，
// 支持 resetTimeoutOnProgress 的客户端（Claude Code / MCP SDK client）会据此续期。
// 每次调用结束写一行 calls.jsonl：排队 / 运行 / 总耗时、模型、usage、错误。
const guard = (name, fn) => async (args, extra) => {
  const token = extra?._meta?.progressToken; let tick = 0;
  const beat = token !== undefined && extra?.sendNotification
    ? setInterval(() => { tick++; extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: tick, message: `working… ${tick * 8}s` } }).catch(() => {}); }, 8000)
    : null;
  const t0 = Date.now(); let r;
  try { r = await fn(args); }
  catch (e) { r = { ok: false, code: 'invalid_input', message: e.message }; }
  finally { if (beat) clearInterval(beat); }
  logCall({
    tool: name, input: String(args.query ?? args.prompt ?? args.instruction ?? args.url ?? '').slice(0, 200),
    backend: r.backend, mode: r.mode, model: r.model ?? args.model ?? null, effort: r.effort,
    ok: r.ok, code: r.code, queued_ms: r.queued_ms, lock_wait_ms: r.lock_wait_ms, run_ms: r.elapsed_ms, total_ms: Date.now() - t0,
    usage: r.usage, searches: r.searches_made?.length, attempts: r.attempts?.map((x) => `${x.backend}:${x.ok ? 'ok' : x.code}`), errors: r.ok === false ? [r.message, ...(r.errors ?? []).slice(-3)].filter(Boolean) : undefined,
  });
  return text(r);
};
// Claude 后端默认关闭（本机没有 Claude 订阅）；设 SUBPOW_ENABLE_CLAUDE=1 重新注册 claude_* 工具
const ENABLE_CLAUDE = process.env.SUBPOW_ENABLE_CLAUDE === '1';
const registerClaudeTool = (...a) => { if (ENABLE_CLAUDE) server.registerTool(...a); };

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
}, guard('codex_generate_image', codex.generateImage));

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
}, guard('codex_edit_image', codex.editImage));

server.registerTool('codex_web_search', {
  title: 'Web search via Codex (OpenAI native web_search, ChatGPT subscription)',
  description: 'Live web search using OpenAI\'s native web_search tool inside Codex, billed to the ChatGPT subscription. mode "quick" (default; gpt-6-luna, medium effort): ONE search, returns up to max_results (default 10) items of {title, url, summary} — use it to find pages/facts fast. mode "deep" (gpt-6.1-sol, medium effort): several searches plus a synthesized answer with sources — use for questions that need comparing sources. Each call takes tens of seconds to minutes; calls are queued one at a time per session.',
  inputSchema: {
    query: z.string().min(2).describe('The search query or research question, in any language.'),
    mode: z.enum(['quick', 'deep']).optional().describe('quick (default): one search, result list only. deep: multi-search research with a written answer.'),
    max_results: z.number().int().min(1).max(10).optional().describe('Max items to return. Default 10 for quick, 5 for deep.'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard('codex_web_search', codex.webSearch));

registerClaudeTool('claude_web_search', {
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
}, guard('claude_web_search', claude.webSearch));

registerClaudeTool('claude_web_fetch', {
  title: 'Fetch & read a URL via Claude Code WebFetch',
  description: 'Fetch one URL with Claude Code\'s WebFetch (server-side fetch, 15-min cache, handles JS-light pages) and answer a question about it or summarize it. Cheaper than a search.',
  inputSchema: {
    url: z.string().url(),
    prompt: z.string().optional().describe('What to extract/answer from the page. Default: faithful summary.'),
    model: z.string().optional(),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard('claude_web_fetch', claude.webFetch));

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
}, guard('codex_run', codex.runTask));

registerClaudeTool('claude_run', {
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
}, guard('claude_run', claude.runTask));

// ChatGPT Pro Dot 搜索：实验性、默认关闭。开关在 ~/.subscription-powers/config.json（`node server/bin/subpow.mjs dot on|off`），
// 运行中热生效：开关变化时 enable()/disable() 工具，SDK 会自动发 tools/list_changed，客户端无需重启会话。
const dotTool = server.registerTool('dot_web_search', {
  title: 'Web search via ChatGPT Pro Dot (experimental, switchable)',
  description: 'Live web search through the user\'s ChatGPT Pro "Dot" (calls the chatgpt.com messaging API directly, no per-token cost). mode "quick" (default): returns up to max_results (default 10) items of {title, url, summary}. mode "deep": several searches, a written answer plus source URLs. NOTE: every call posts a real message into the user\'s personal Dot chat and wakes its computer — use it for genuine lookups, not bulk/looped queries (prefer codex_web_search for volume). Calls are serialized across all sessions; typically 5–30 s.',
  inputSchema: {
    query: z.string().min(2).describe('The search query or research question, in any language.'),
    mode: z.enum(['quick', 'deep']).optional().describe('quick (default): result list only. deep: multi-search research with a written answer.'),
    max_results: z.number().int().min(1).max(10).optional().describe('Max items / sources. Default 10 for quick, 5 for deep.'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard('dot_web_search', dot.webSearch));

// Codex 直连 API 搜索：实验性、默认关闭，同样热开关（`node server/bin/subpow.mjs codex on|off`）。
const codexApiTool = server.registerTool('codex_api_search', {
  title: 'Web search via Codex Responses API (experimental, switchable)',
  description: 'Live web search by calling the ChatGPT Codex Responses endpoint directly (no codex subprocess): OpenAI\'s hosted web_search is forced, sources are structured. Much faster and lighter on quota than codex_web_search (typically 5–15 s, ~9–13K input tokens). mode "quick" (default; gpt-6-luna, low effort): up to max_results (default 10) items of {title, url, summary} plus other consulted URLs. mode "deep" (gpt-6.1-sol, medium effort): a written answer with cited sources. Uses the user\'s Codex login read-only.',
  inputSchema: {
    query: z.string().min(2).describe('The search query or research question, in any language.'),
    mode: z.enum(['quick', 'deep']).optional().describe('quick (default): result list. deep: researched answer with sources.'),
    max_results: z.number().int().min(1).max(10).optional().describe('Max items / sources. Default 10 for quick, 5 for deep.'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    model: z.string().optional().describe('Override the model, e.g. gpt-6.1-sol.'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe('Override the reasoning effort.'),
    timeout_ms: z.number().int().min(10_000).max(300_000).optional(),
  },
}, guard('codex_api_search', codexApi.webSearch));

// 固定 ChatGPT 网页会话搜索：实验性、默认关闭（`node server/bin/subpow.mjs web session set <网址>` 再 `web on`）。
// 经 chrome-agent-bridge 在用户指定的那个会话页面里发消息，所以 Chrome 要开着该页面。
const chatgptWebTool = server.registerTool('chatgpt_web_search', {
  title: 'Web search via a fixed ChatGPT web conversation (experimental, switchable)',
  description: 'Live web search by driving ONE fixed ChatGPT web conversation the user configured (types the query into that open Chrome tab, reads the structured sources back). Sources come with title, URL, snippet and date. Needs Chrome open with that conversation visible, and uses whatever model the page has selected. mode "quick" (default): up to max_results (default 10) items of {title, url, summary, published?}. mode "deep": a researched answer plus source URLs. NOTE: every call posts a real message into that conversation; typically 8–25 s. Not for bulk use.',
  inputSchema: {
    query: z.string().min(2).describe('The search query or research question, in any language.'),
    mode: z.enum(['quick', 'deep']).optional().describe('quick (default): result list. deep: researched answer with sources.'),
    max_results: z.number().int().min(1).max(10).optional().describe('Max items / sources. Default 10 for quick, 5 for deep.'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    timeout_ms: z.number().int().min(30_000).max(600_000).optional(),
  },
}, guard('chatgpt_web_search', chatgptWeb.webSearch));

// 统一搜索入口：按 Dot → Codex 直连 API → Codex CLI 的顺序尝试（可在配置里改顺序），失败或未开启就换下一个。
server.registerTool('web_search', {
  title: 'Web search (unified: tries every enabled backend in order)',
  description: 'Live web search — call this whenever an answer depends on current or online information instead of answering from memory (works even when the host has no built-in web search). Tries the switched-on backends in order (default: ChatGPT Dot → Codex direct API → fixed ChatGPT web session → Codex CLI), skipping any that are off or auto-disabled and falling through on failure; the reply says which backend answered (`backend`) and what was tried (`attempts`, `skipped`). mode "quick" (default): {title, url, summary} items. mode "deep": a researched answer plus sources. Same result shape whichever backend answers.',
  inputSchema: {
    query: z.string().min(2).describe('The search query or research question, in any language.'),
    mode: z.enum(['quick', 'deep']).optional().describe('quick (default): result list. deep: researched answer with sources.'),
    max_results: z.number().int().min(1).max(10).optional().describe('Max items / sources. Default 10 for quick, 5 for deep.'),
    recency: z.string().optional().describe('e.g. "week", "month", "year" — bias toward fresh sources.'),
    backends: z.array(z.enum(SEARCH_BACKENDS)).optional().describe('Override the backend order for this call, e.g. ["codex_api"].'),
    timeout_ms: z.number().int().min(10_000).max(600_000).optional(),
  },
}, guard('web_search', search.webSearch));

// 开关热生效：监听配置文件，开关 / 熔断变化时 enable()/disable() 对应工具（SDK 自动发 tools/list_changed）
const hot = [[dotTool, dotActive], [codexApiTool, codexApiActive], [chatgptWebTool, chatgptWebActive]];
const syncHot = () => { for (const [tool, active] of hot) { const on = active(); if (tool.enabled !== on) on ? tool.enable() : tool.disable(); } };
syncHot();
fs.watchFile(CONFIG_FILE, { interval: 2000 }, syncHot);

await server.connect(new StdioServerTransport());
