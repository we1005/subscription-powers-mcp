import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexApiError, tokenInfo } from './codex-wire.mjs';

/**
 * 凭据方案 B：只读借用 Codex CLI 自己的登录文件 ~/.codex/auth.json。
 *   - 只读：从不刷新、不写回、不打印令牌；每次调用都重新读文件，Codex CLI 刷新后我们立刻用上新令牌。
 *   - 令牌过期时不自己续期（续期会轮换刷新令牌，可能把 Codex CLI 登出），直接报 codex_api_token_expired。
 *   - 始终用个人的 ~/.codex，不理会 CODEX_HOME（那可能指向公司环境）。SUBPOW_CODEX_AUTH_FILE 仅供测试覆盖。
 * TODO（方案 A）：自己做 OAuth 登录并独立保存令牌，见 docs/codex-oauth-websearch-plan.zh.md §4。
 */
export const authFile = () => process.env.SUBPOW_CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');

export function readCodexAuth(now = Date.now()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(authFile(), 'utf8')); }
  catch { throw new CodexApiError('codex_api_no_credentials', `cannot read ${authFile()} — log in with the Codex CLI first (\`codex login\`)`); }
  const t = raw?.tokens;
  if ((raw?.auth_mode && raw.auth_mode !== 'chatgpt') || !t?.access_token) throw new CodexApiError('codex_api_no_credentials', `Codex is not logged in with a ChatGPT account (auth_mode=${raw?.auth_mode ?? 'none'})`);
  const info = tokenInfo(t.access_token);
  const accountId = t.account_id || info.accountId;
  if (!accountId) throw new CodexApiError('codex_api_no_credentials', 'Codex login file has no ChatGPT account id');
  if (info.exp && info.exp < now + 60_000) {
    throw new CodexApiError('codex_api_token_expired', `Codex access token expired ${new Date(info.exp).toISOString().slice(0, 16)}Z; it is refreshed whenever the Codex CLI/app is used (read-only borrow never refreshes it)`);
  }
  return { accessToken: t.access_token, accountId, plan: info.plan, residency: info.residency, exp: info.exp, lastRefresh: raw.last_refresh };
}
