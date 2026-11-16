/**
 * Elapsed seconds for the running-load hints (the full-area loader, the in-grid
 * busy pill, ...).
 *
 * One decimal on purpose: the grid footer renders a finished run through
 * `formatQueryDuration` ("2.2 s"), so a two-decimal counter here made the same
 * value jump between formats while loading and after it finished (#10439/#10441).
 */
export function formatElapsedSeconds(ms: number): string {
  return (Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000).toFixed(1);
}
