import { uuid } from "@/lib/common/utils";

export interface BatchTableEmptyResult<T> {
  succeeded: T[];
  failed: Array<{ target: T; error: unknown }>;
  skipped?: Array<{ target: T; reason: string; dependency?: string }>;
  cancelled?: T[];
}

export interface BatchTableEmptyPlanItem<T> {
  target: T;
  sql: string;
}

export type BatchTableEmptyFeedback = "success" | "partial" | "submitted" | "submitted-partial";

export async function buildBatchTableEmptyPlan<T>(targets: readonly T[], buildSql: (target: T) => Promise<string>, options: { concurrency?: number; isCancelled?: () => boolean; onProgress?: (completed: number, total: number) => void } = {}): Promise<BatchTableEmptyPlanItem<T>[]> {
  const plan: Array<BatchTableEmptyPlanItem<T> | undefined> = Array.from({ length: targets.length });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 16));
  let cursor = 0;
  let completed = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (!stopped && cursor < targets.length) {
      if (options.isCancelled?.()) {
        stopped = true;
        firstError ??= new Error("Operation cancelled");
        return;
      }
      const index = cursor++;
      try {
        const sql = await buildSql(targets[index]!);
        if (!sql.trim()) throw new Error("Empty table SQL preview is unavailable");
        if (stopped) return;
        plan[index] = { target: targets[index]!, sql };
        options.onProgress?.(++completed, targets.length);
      } catch (error) {
        stopped = true;
        firstError ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return plan.filter((item): item is BatchTableEmptyPlanItem<T> => item !== undefined);
}

export async function runBatchTableEmpty<T>(targets: readonly T[], execute: (target: T) => Promise<void>): Promise<BatchTableEmptyResult<T>> {
  const result: BatchTableEmptyResult<T> = { succeeded: [], failed: [] };
  for (const target of targets) {
    try {
      await execute(target);
      result.succeeded.push(target);
    } catch (error) {
      result.failed.push({ target, error });
    }
  }
  return result;
}

export async function runBatchTableEmptyLayers<T>(
  layers: readonly { items: readonly BatchTableEmptyPlanItem<T>[]; dependencies?: Record<string, string[]> }[],
  options: {
    concurrency?: number;
    execute: (item: BatchTableEmptyPlanItem<T>, executionId: string) => Promise<void>;
    isCancelled?: () => boolean;
    keyOf?: (target: T) => string;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<BatchTableEmptyResult<T>> {
  const result: BatchTableEmptyResult<T> = { succeeded: [], failed: [], skipped: [], cancelled: [] };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 16));
  let completed = 0;
  const total = layers.reduce((sum, layer) => sum + layer.items.length, 0);

  for (const layer of layers) {
    const queue = [...layer.items];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        const key = options.keyOf?.(item.target);
        const blockedBy = key && layer.dependencies?.[key]?.find((dependency) => result.failed.some(({ target }) => options.keyOf?.(target) === dependency) || result.skipped?.some(({ target }) => options.keyOf?.(target) === dependency));
        if (blockedBy) {
          (result.skipped ??= []).push({ target: item.target, reason: `blocked by ${blockedBy}`, dependency: blockedBy });
          completed += 1;
          options.onProgress?.(completed, total);
          continue;
        }
        if (options.isCancelled?.()) {
          (result.cancelled ??= []).push(item.target);
          completed += 1;
          options.onProgress?.(completed, total);
          continue;
        }
        const executionId = uuid();
        try {
          await options.execute(item, executionId);
          result.succeeded.push(item.target);
        } catch (error) {
          if (options.isCancelled?.()) (result.cancelled ??= []).push(item.target);
          else result.failed.push({ target: item.target, error });
        } finally {
          completed += 1;
          options.onProgress?.(completed, total);
        }
      }
    });
    await Promise.all(workers);
  }
  return result;
}

export function batchTableEmptyFeedback(result: BatchTableEmptyResult<unknown>, asynchronousMutation: boolean): BatchTableEmptyFeedback {
  const incomplete = result.failed.length > 0 || (result.skipped?.length ?? 0) > 0 || (result.cancelled?.length ?? 0) > 0;
  if (asynchronousMutation) return incomplete ? "submitted-partial" : "submitted";
  return incomplete ? "partial" : "success";
}
