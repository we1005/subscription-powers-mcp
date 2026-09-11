/** 每个后端一条串行队列：订阅额度和 CLI 冷启动都不适合并发 */
const chains = new Map();
export function serial(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  return next;
}
