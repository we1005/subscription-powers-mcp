/**
 * ChatGPT Codex 后端（Responses 接口）的常量与纯函数。
 * Adapted from can1357/oh-my-pi (MIT) — packages/catalog/src/wire/codex.ts, packages/ai/src/providers/openai-codex-responses.ts
 * 版权：Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.（许可全文见 THIRD_PARTY_NOTICES.md）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
// 后端按这个版本号决定哪些模型可见。运行时优先取本机 `codex --version`；取不到才用这个后备值
export const FALLBACK_CLIENT_VERSION = '0.163.0';
// 如实标明身份，不冒充 codex_cli_rs（实测后端接受自定义值）
export const ORIGINATOR = 'subscription-powers';
const JWT_CLAIM = 'https://api.openai.com/auth';

export class CodexApiError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); }
}

/** 与官方客户端一样把基础地址规整成 …/codex/responses */
export function resolveResponsesUrl(base = CODEX_BASE_URL) {
  const raw = base && base.trim() ? base : CODEX_BASE_URL;
  const n = raw.replace(/\/+$/, '');
  if (n.endsWith('/codex/responses')) return n;
  if (n.endsWith('/codex')) return `${n}/responses`;
  return `${n}/codex/responses`;
}

export function decodeJwt(token) {
  try { const p = String(token).split('.'); if (p.length !== 3) return null; return JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8')); } catch { return null; }
}

/**
 * 从 access token 读取：过期时间、账号、套餐、数据驻留区。
 * 区域锁定的企业空间不带驻留头会 401；"no_constraint" 表示没有锁定，不能发（后端会 404）。
 */
export function tokenInfo(token) {
  const c = decodeJwt(token);
  const a = c?.[JWT_CLAIM] ?? {};
  let residency;
  for (const v of [a.chatgpt_data_residency, a.chatgpt_compute_residency]) {
    if (typeof v !== 'string' || !v.trim()) continue;
    residency = v.trim().toLowerCase() === 'no_constraint' ? undefined : v.trim();
    break;
  }
  return { exp: c?.exp ? c.exp * 1000 : 0, accountId: a.chatgpt_account_id, plan: a.chatgpt_plan_type, residency };
}

export function buildHeaders({ accessToken, accountId, residency, version }) {
  const h = {
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'openai-beta': 'responses=experimental',
    originator: ORIGINATOR,
    version,
    'user-agent': `subscription-powers/0.1 (+codex-api)`,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  if (residency) h['x-openai-internal-codex-residency'] = residency;
  return h;
}

let cachedVersion;
/** 本机 Codex CLI 的版本号（后端按它做模型可见性门槛，写死会过期）。SUBPOW_CODEX_VERSION 可覆盖 */
export async function clientVersion() {
  if (process.env.SUBPOW_CODEX_VERSION) return process.env.SUBPOW_CODEX_VERSION;
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout } = await promisify(execFile)('codex', ['--version'], { timeout: 5000 });
    cachedVersion = stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {}
  return (cachedVersion ??= FALLBACK_CLIENT_VERSION);
}

/** 与 oh-my-pi 相同的错误归类：后端的错误包装有三种（顶层 / error / response.error） */
export function extractSseError(ev) {
  let code = '', message = '';
  for (const c of [ev, ev?.error, ev?.response?.error]) {
    if (!c || typeof c !== 'object') continue;
    if (!code && typeof c.code === 'string' && c.code) code = c.code;
    if (!message && typeof c.message === 'string' && c.message) message = c.message;
  }
  return { code, message };
}
export function statusFromText(code, message) {
  const d = `${code} ${message}`.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|\b429\b/.test(d)) return 429;
  if (/unauthori[sz]ed|\b401\b/.test(d)) return 401;
  if (/forbidden|\b403\b/.test(d)) return 403;
  if (/timeout|timed out/.test(d)) return 504;
  return 500;
}
