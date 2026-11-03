import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DIR } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plainError = (code, message) => Object.assign(new Error(message), { code });

/**
 * 跨进程串行：每个 Agent 会话都有自己的 MCP 进程，但 Dot 房间、固定的网页会话都只有一个，
 * 用 `<name>.lock`（wx 独占创建 + 心跳）保证同一时刻只有一个请求在里面。minGapMs 是释放后的最小间隔。
 */
export async function withLock(name, minGapMs, fn, makeError = plainError) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const f = path.join(DIR, `${name}.lock`); const t0 = Date.now();
  for (;;) {
    try { const h = await fsp.open(f, 'wx', 0o600); await h.writeFile(String(process.pid)); await h.close(); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fsp.stat(f).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 120_000) { await fsp.rm(f, { force: true }); continue; }   // 持锁进程已崩溃（心跳停了）
      if (Date.now() - t0 > 600_000) throw makeError(`${name}_busy`, `another process has held the ${name} lock for over 10 minutes`);
      await sleep(500);
    }
  }
  const beat = setInterval(() => fsp.utimes(f, new Date(), new Date()).catch(() => {}), 20_000);
  try { return await fn(Date.now() - t0); }
  finally { clearInterval(beat); setTimeout(() => fsp.rm(f, { force: true }).catch(() => {}), minGapMs); }
}
