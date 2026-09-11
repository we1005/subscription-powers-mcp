// 子进程环境：必须用「个人」订阅的 HOME，并剥掉父进程（可能是 Claude Code 会话 / 公司环境）注入的一切
const DROP_EXACT = new Set([
  'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CODEX_HOME', 'MAKEPLAY_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
]);
const DROP_PREFIX = ['CLAUDE_CODE_'];
export function cleanEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (DROP_EXACT.has(k)) continue;
    if (DROP_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return { ...out, CI: '1', NO_COLOR: '1', TERM: 'dumb', ...extra };
}
