/**
 * Pure decision functions for Redis key auto-refresh countdown.
 *
 * Extracted from RedisValueViewer.vue to enable unit testing of the
 * state-machine logic without mounting a Vue component.
 */

/** Action computed after evaluating one auto-refresh tick. */
export type AutoRefreshTickAction = { type: "idle" } | { type: "decrement" } | { type: "refresh" };

/**
 * Evaluate one tick of the auto-refresh interval.
 *
 * @param enabled  Whether auto-refresh is currently toggled on.
 * @param countdownTtl  Current countdown value in seconds.
 * @param isLoading  Whether a data load is already in flight.
 * @returns The action the caller should take this tick.
 */
export function computeAutoRefreshTick(enabled: boolean, countdownTtl: number, isLoading: boolean): AutoRefreshTickAction {
  if (!enabled) return { type: "idle" };
  if (isLoading) return countdownTtl > 0 ? { type: "decrement" } : { type: "idle" };
  return countdownTtl <= 1 ? { type: "refresh" } : { type: "decrement" };
}

/**
 * Determine whether auto-refresh should be automatically disabled
 * after a server load completes (e.g. key expired or deleted).
 *
 * @param ttl  The TTL value returned by the server (seconds, -1 = no expiry).
 */
export function shouldStopAutoRefresh(ttl: number): boolean {
  return ttl <= 0;
}

/**
 * Compute the TTL value that should be displayed in the badge.
 *
 * When auto-refresh is active, the live countdown value is shown. The
 * last known server TTL must not reappear after the countdown reaches zero.
 */
export function computeDisplayTtl(autoRefreshEnabled: boolean, countdownTtl: number, serverTtl: number): number {
  return autoRefreshEnabled ? Math.max(countdownTtl, 0) : serverTtl;
}
