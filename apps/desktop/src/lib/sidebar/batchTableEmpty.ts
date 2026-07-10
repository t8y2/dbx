export interface BatchTableEmptyResult<T> {
  succeeded: T[];
  failed: Array<{ target: T; error: unknown }>;
}

export type BatchTableEmptyFeedback = "success" | "partial" | "submitted" | "submitted-partial";

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

export function batchTableEmptyFeedback(result: BatchTableEmptyResult<unknown>, asynchronousMutation: boolean): BatchTableEmptyFeedback {
  if (asynchronousMutation) return result.failed.length > 0 ? "submitted-partial" : "submitted";
  return result.failed.length > 0 ? "partial" : "success";
}
