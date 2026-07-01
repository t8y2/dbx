/**
 * Frontend memory-budget helpers for query result sets. The WebView renderer can balloon to
 * multiple GB when large results accumulate across inactive tabs; these helpers cap that.
 */

/** Total byte budget for inactive-tab result caches held in memory. Results beyond this are
 * evicted to disk (oldest first) even if fewer than MAX_CACHED_RESULTS tabs are inactive. */
export const MAX_RESULT_CACHE_BYTES = 300 * 1024 * 1024;
/** Thresholds that trigger a "large result" warning so the user shrinks page size or exports. */
export const LARGE_RESULT_WARN_BYTES = 50 * 1024 * 1024;
export const LARGE_RESULT_WARN_ROWS = 100_000;
/** Cap the number of rows sampled when estimating, so estimation stays cheap on huge results. */
const ESTIMATE_SAMPLE_ROWS = 512;

export type ResultLike = { rows?: unknown[][] } | null | undefined;

function estimateValueBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "string") return value.length + 2;
  try {
    return Math.min(JSON.stringify(value).length, 2048);
  } catch {
    return 64;
  }
}

/** Rough byte estimate of a result set's rows, sampled to stay cheap on huge results. */
export function estimateResultBytes(result: ResultLike): number {
  const rows = result?.rows;
  if (!rows || rows.length === 0) return 0;
  const total = rows.length;
  const sample = Math.min(total, ESTIMATE_SAMPLE_ROWS);
  let sampled = 0;
  for (let i = 0; i < sample; i += 1) {
    const row = rows[i];
    if (!row) continue;
    for (const value of row) sampled += estimateValueBytes(value);
  }
  return Math.round((sampled / sample) * total);
}

/** True when a result is large enough to warrant a user-facing warning. */
export function isLargeResult(result: ResultLike): boolean {
  if (!result?.rows) return false;
  return result.rows.length >= LARGE_RESULT_WARN_ROWS || estimateResultBytes(result) >= LARGE_RESULT_WARN_BYTES;
}
