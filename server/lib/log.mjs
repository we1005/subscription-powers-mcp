import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

/** 每次工具调用追加一行 JSON 到 ~/.cache/subscription-powers/calls.jsonl；写失败不影响调用本身 */
const FILE = path.join(os.homedir(), '.cache', 'subscription-powers', 'calls.jsonl');
let ready;
export function logCall(entry) {
  ready ??= fs.mkdir(path.dirname(FILE), { recursive: true });
  ready.then(() => fs.appendFile(FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\n')).catch(() => {});
}
