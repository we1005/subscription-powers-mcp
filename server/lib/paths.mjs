import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
const HOME = os.homedir();
const FORBIDDEN = ['.codex', '.codex-company', '.claude', '.claude-company', '.ssh', '.gnupg', '.aws', '.config/opencode', '.omp'].map((d) => path.join(HOME, d));
export function assertSafeAbs(p, label) {
  if (!path.isAbsolute(p)) throw new Error(`${label} must be an absolute path: ${p}`);
  const r = path.resolve(p);
  for (const f of FORBIDDEN) if (r === f || r.startsWith(f + path.sep)) throw new Error(`${label} may not point into ${f}`);
  return r;
}
export async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); return d; }
export async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
/** 兜底：out_dir 里最新的图片文件 */
export async function newestImage(dir, since) {
  const ents = await fs.readdir(dir).catch(() => []);
  let best = null;
  for (const n of ents) {
    if (!/\.(png|jpe?g|webp)$/i.test(n)) continue;
    const full = path.join(dir, n); const st = await fs.stat(full).catch(() => null);
    if (st && st.mtimeMs >= since - 2000 && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs };
  }
  return best?.full ?? null;
}
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
