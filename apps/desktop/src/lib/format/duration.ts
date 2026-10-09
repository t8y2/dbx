/**
 * Adaptive, glance-friendly duration formatting for query/UI elapsed hints
 * (issue #10117: raw millisecond readouts like "5230ms" scale poorly).
 *
 * Tiers (identical to the former `formatDataTransferDuration` in
 * useExportTracker, now shared):
 *   < 1s   -> "N ms"    (integer milliseconds)
 *   < 60s  -> "X.X s"   (one decimal, floor-truncated)
 *   < 1h   -> "Nm Ss"
 *   >= 1h  -> "Hh MMm Ss"
 */

export function formatQueryDuration(elapsedMs: number): string {
  const safeElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? Math.round(elapsedMs) : 0);
  if (safeElapsedMs < 1000) return `${safeElapsedMs} ms`;

  if (safeElapsedMs < 60_000) return `${(Math.floor(safeElapsedMs / 100) / 10).toFixed(1)} s`;

  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m ${seconds}s`;
}

/**
 * Server-side execution times reported in microseconds (OceanBase SQL Audit
 * EXECUTE_TIME): keep µs below one millisecond, then reuse the ms tiers.
 */
export function formatDurationUs(micros: number): string {
  const safeMicros = Math.max(0, Number.isFinite(micros) ? Math.round(micros) : 0);
  if (safeMicros < 1000) return `${safeMicros} µs`;
  return formatQueryDuration(safeMicros / 1000);
}
