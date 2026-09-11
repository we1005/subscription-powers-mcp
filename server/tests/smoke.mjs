// 冒烟测试：起 server，列工具，按需真实调用（每个真实调用都消耗订阅额度，默认只跑便宜的；--full 跑全部）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes('--full');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(here, '..', 'index.mjs')] }));
const tools = (await client.listTools()).tools;
console.log('tools:', tools.map((t) => t.name).join(', '));
const call = async (name, args) => {
  if (only.length && !only.includes(name)) return;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, resetTimeoutOnProgress: true, onprogress: (p) => process.stdout.write(`  …${p.message ?? p.progress}\r`) });
  const body = JSON.parse(r.content[0].text);
  console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) ok=${body.ok}`);
  const { answer, ...rest } = body; console.log(JSON.stringify(rest, null, 1).slice(0, 900)); if (answer) console.log('answer:', String(answer).slice(0, 400));
};
await call('claude_web_fetch', { url: 'https://github.com/ggml-org/llama.cpp/releases', prompt: 'What is the newest release tag on this page? One line.' });
if (full || only.length) {
  await call('codex_web_search', { query: 'llama.cpp 最近一周最新的 release tag 是什么？', max_results: 3 });
  await call('claude_web_search', { query: 'What is the latest stable Node.js LTS version right now?', max_results: 3 });
  await call('codex_generate_image', { prompt: 'a minimalist flat-vector blue paper plane icon on white background', out_dir: path.join(os.tmpdir(), 'subpow-smoke'), size: '1024x1024', style: 'flat vector' });
}
await client.close();
