import type { QueryResult } from "@/types/database";

/** Local command timing; run wraps only backend calls, never result conversion. */
export function createQueryRequestTiming(prepareStartedAt: number) {
  let firstRequestAt: number | undefined;
  let waitMs = 0;
  let requests = 0;
  return {
    async run<T, A extends unknown[]>(request: (...args: A) => Promise<T>, ...args: A): Promise<T> {
      const startedAt = performance.now();
      firstRequestAt ??= startedAt;
      requests += 1;
      try {
        return await request(...args);
      } finally {
        waitMs += Math.max(0, performance.now() - startedAt);
      }
    },
    finish<T extends QueryResult>(result: T): T {
      if (firstRequestAt === undefined || result.execution_error) return result;
      result.client_prepare_ms = Math.max(0, firstRequestAt - prepareStartedAt);
      result.client_request_wait_ms = waitMs;
      result.client_result_ms = Math.max(0, performance.now() - firstRequestAt - waitMs);
      result.timing_page_count = requests;
      return result;
    },
  };
}
