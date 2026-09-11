import { spawn } from 'node:child_process';
const TAIL = 16 * 1024;
const tail = (s) => (s.length > TAIL ? '…' + s.slice(-TAIL) : s);
/** 起子进程，带超时（先 SIGTERM 再 SIGKILL），返回完整 stdout（供 JSON 事件解析）与截尾 stderr */
export function run(cmd, args, { cwd, env, timeoutMs, onStdoutLine }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false, spawnError;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let lineBuf = '';
    child.stdout.on('data', (b) => {
      const s = b.toString('utf8'); stdout += s;
      if (onStdoutLine) { lineBuf += s; const parts = lineBuf.split('\n'); lineBuf = parts.pop(); parts.forEach(onStdoutLine); }
    });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); if (stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL * 2); });
    child.on('error', (e) => { spawnError = e; });
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (onStdoutLine && lineBuf) onStdoutLine(lineBuf);
      resolve({ exitCode: code, stdout, stderrTail: tail(stderr), timedOut, spawnError, elapsedMs: Date.now() - started });
    });
  });
}
export function classify(o, who) {
  const t = `${o.stdout.slice(-4000)}\n${o.stderrTail}`;
  if (o.spawnError?.code === 'ENOENT') return { code: `${who}_not_installed`, message: `${who} CLI not found on PATH` };
  if (o.timedOut) return { code: `${who}_timeout`, message: `${who} did not finish within the timeout` };
  if (/not (logged in|authenticated)|please (log ?in|run .*login)|codex login|claude login|Invalid API key|authentication_error/i.test(t)) return { code: `${who}_not_authed`, message: `${who} is not logged in (run \`${who} login\` / \`${who}\` and sign in)` };
  if (/content[- ]policy|safety system|cannot (generate|create) this|policy violation|refus/i.test(t)) return { code: 'content_policy', message: 'provider refused the request on policy grounds' };
  if (/rate limit|usage limit|quota|too many requests|429/i.test(t)) return { code: `${who}_rate_limited`, message: `${who} subscription rate/usage limit hit` };
  if (o.exitCode !== 0) return { code: `${who}_internal_error`, message: `${who} exited with code ${o.exitCode}` };
  return null;
}
