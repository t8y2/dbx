/** Small cancellation checkpoints need not each consume a browser frame. */
export function createRedisKeyViewYield(options: { now?: () => number; yieldTask?: () => Promise<void>; budgetMs?: number } = {}): () => Promise<void> {
  const now = options.now ?? (() => performance.now());
  const yieldTask = options.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const budget = options.budgetMs ?? 8;
  let started = now();
  return async () => {
    if (now() - started < budget) return;
    await yieldTask();
    started = now();
  };
}
