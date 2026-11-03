/** 每个后端一条串行队列：订阅额度和 CLI 冷启动都不适合并发。结果对象上附带排队等待时间 queued_ms */
const chains = new Map();
export function serial(key, fn) {
  const enqueued = Date.now();
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const queued_ms = Date.now() - enqueued;
    const r = await fn();
    return r && typeof r === 'object' ? { ...r, queued_ms } : r;
  });
  chains.set(key, next);
  return next;
}
