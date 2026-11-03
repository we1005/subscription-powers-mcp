import fs from 'node:fs';
import * as dot from './dot.mjs';
import * as codexApi from './codex-api.mjs';
import * as chatgptWeb from './chatgpt-web.mjs';
import * as codexCli from './codex.mjs';
import { getDot, getCodexApi, getChatgptWeb, getSearchOrder, CRED_FILE } from './store.mjs';

/**
 * 统一搜索入口：按顺序尝试各后端，失败或未开启就换下一个。
 * available() 返回 null 表示可用，否则返回不可用的原因（该后端会被跳过，不算一次失败）。
 * Codex CLI 永远可用，是最后的兜底；它每次运行还会顺带刷新 ~/.codex/auth.json 里过期的令牌（Codex CLI 自己的行为，未专门验证）。
 */
const offReason = (c) => (!c.enabled ? 'switched off' : c.tripped ? `auto-disabled (${c.tripped_reason})` : null);
export const REGISTRY = {
  dot: { available: () => offReason(getDot()) ?? (fs.existsSync(CRED_FILE) ? null : 'no credentials'), run: (a) => dot.webSearch(a) },
  codex_api: { available: () => offReason(getCodexApi()), run: (a) => codexApi.webSearch(a) },
  chatgpt_web: { available: () => offReason(getChatgptWeb()) ?? (process.env.SUBPOW_CHATGPT_SESSION_URL || getChatgptWeb().session_url ? (fs.existsSync(CRED_FILE) ? null : 'no login state (run: subpow dot capture)') : 'no session configured'), run: (a) => chatgptWeb.webSearch(a) },
  codex_cli: { available: () => null, run: (a) => codexCli.webSearch(a) },
};

export async function webSearch(a, { registry = REGISTRY } = {}) {
  const order = a.backends?.length ? a.backends : getSearchOrder();
  const attempts = [], skipped = [];
  for (const name of order) {
    const b = registry[name];
    if (!b) continue;
    const why = b.available();
    if (why) { skipped.push({ backend: name, reason: why }); continue; }
    const t0 = Date.now(); let r;
    try { r = await b.run(a); } catch (e) { r = { ok: false, code: 'exception', message: e.message }; }
    attempts.push({ backend: name, ok: !!r.ok, code: r.code, message: r.ok ? undefined : String(r.message ?? '').slice(0, 160), ms: Date.now() - t0 });
    if (r.ok) return { ...r, backend: name, attempts, skipped };
    if (r.code === 'invalid_input') return { ...r, backend: name, attempts, skipped };
  }
  return {
    ok: false, code: attempts.length ? 'all_backends_failed' : 'no_backend_available',
    message: attempts.length ? `all search backends failed — ${attempts.map((x) => `${x.backend}: ${x.code}`).join('; ')}` : `no search backend is available — ${skipped.map((x) => `${x.backend}: ${x.reason}`).join('; ')}`,
    attempts, skipped,
  };
}
