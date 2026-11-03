import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** 本地状态目录（隐藏、仅本人可读）：开关配置 + Dot 登录态。SUBPOW_HOME 可覆盖（测试用） */
export const DIR = process.env.SUBPOW_HOME || path.join(os.homedir(), '.subscription-powers');
export const CONFIG_FILE = path.join(DIR, 'config.json');
export const CRED_FILE = path.join(DIR, 'dot-credentials.json');

export function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
/** 原子写：文件 0600、目录 0700 */
export function writeJson(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 每个可开关的后端一个配置块。enabled = 人工开关（默认关）；tripped = 连续失败后被自动熔断。两者都满足才对外提供
const BREAKER = { enabled: false, tripped: false, tripped_reason: null, consecutive_failures: 0, trip_after: 3 };
const DEFAULTS = {
  // auto_recapture：登录态失效时自动从日常 Chrome（chrome-agent-bridge）重新抓取；会附加调试器，默认关。dot_url 是上次见到的 Dot 标签页地址
  dot: { ...BREAKER, min_interval_ms: 2000, timeout_ms: 120_000, auto_recapture: false, recapture_cooldown_ms: 600_000, last_recapture_at: null, dot_url: null },
  // bound_plan / bound_account：开启时记录的套餐与账号，之后令牌里的值变了就立即熔断（套餐到期、换号）
  // chatgpt_web：驱动固定的 ChatGPT 网页会话（经 chrome-agent-bridge 在页面里发消息，Node 读结构化来源）。session_url 必填，没配就报错
  chatgpt_web: { ...BREAKER, min_interval_ms: 2000, timeout_ms: 120_000, session_url: null, conversation_id: null, project_id: null, browser: null },
  codex_api: { ...BREAKER, concurrency: 2, min_interval_ms: 200, timeout_ms: 60_000, bound_plan: null, bound_account: null },
};
export const getCfg = (key) => ({ ...DEFAULTS[key], ...(readJson(CONFIG_FILE, {})[key] ?? {}) });
export function setCfg(key, patch) {
  const cfg = readJson(CONFIG_FILE, {});
  cfg[key] = { ...DEFAULTS[key], ...(cfg[key] ?? {}), ...patch };
  writeJson(CONFIG_FILE, cfg);
  return cfg[key];
}
export const isActive = (c) => c.enabled && !c.tripped;

export const getDot = () => getCfg('dot');
export const setDot = (patch) => setCfg('dot', patch);
export const dotActive = (c = getDot()) => isActive(c);
export const getChatgptWeb = () => getCfg('chatgpt_web');
export const setChatgptWeb = (patch) => setCfg('chatgpt_web', patch);
export const chatgptWebActive = (c = getChatgptWeb()) => isActive(c);
export const getCodexApi = () => getCfg('codex_api');
export const setCodexApi = (patch) => setCfg('codex_api', patch);
export const codexApiActive = (c = getCodexApi()) => isActive(c);

// 统一搜索入口的后端顺序。默认：Dot（不计 Codex 额度）→ Codex 直连 API → 固定网页会话 → Codex CLI
export const SEARCH_BACKENDS = ['dot', 'codex_api', 'chatgpt_web', 'codex_cli'];
export const getSearchOrder = () => {
  const o = readJson(CONFIG_FILE, {}).search?.order;
  return Array.isArray(o) && o.length && o.every((x) => SEARCH_BACKENDS.includes(x)) ? o : SEARCH_BACKENDS;   // 已保存的顺序按字面使用，不自动补后端
};
export function setSearchOrder(order) {
  const cfg = readJson(CONFIG_FILE, {});
  cfg.search = { ...(cfg.search ?? {}), order };
  writeJson(CONFIG_FILE, cfg);
}
