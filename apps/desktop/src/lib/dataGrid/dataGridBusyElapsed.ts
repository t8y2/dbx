/**
 * Baseline of the data grid busy overlay's elapsed pill.
 *
 * `ContentArea` renders only the active result view, so switching between the
 * table, summary, chart and message views unmounts the grid and mounts a new
 * instance when the user comes back. The busy overlay's baseline lived in
 * component state, so a remount during a running query restarted the counter at
 * zero and the elapsed pill no longer matched the real execution time
 * (issue #12821).
 *
 * The query's own start time is authoritative whenever the busy surface is
 * driven by a query execution: it lives on the tab, so it survives the
 * remount. Busy surfaces that no query execution drives (page jumps, row
 * preparation, background counts) keep the previous per-mount baseline, so
 * their elapsed pill still starts when the surface became busy.
 */
export interface ResolveDataGridBusyStartedAtOptions {
  /** Current wall clock, in milliseconds. */
  now: number;
  /** The caller wants a new busy period to start now. */
  reset: boolean;
  /** Baseline of the busy period already running in this grid instance, or 0. */
  currentStartedAt: number;
  /** Start of the query execution behind the busy surface, when there is one. */
  executionStartedAt?: number;
}

export function resolveDataGridBusyStartedAt(options: ResolveDataGridBusyStartedAtOptions): number {
  const { now, reset, currentStartedAt, executionStartedAt } = options;
  // A future timestamp (clock skew, or a tab restored from disk) would render a
  // negative elapsed time, so it is clamped to "just started".
  if (executionStartedAt !== undefined && Number.isFinite(executionStartedAt)) return Math.min(executionStartedAt, now);
  if (reset || !currentStartedAt) return now;
  return currentStartedAt;
}
