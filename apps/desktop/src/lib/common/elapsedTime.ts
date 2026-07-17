export function formatElapsedSeconds(ms: number): string {
  return (Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000).toFixed(2);
}
