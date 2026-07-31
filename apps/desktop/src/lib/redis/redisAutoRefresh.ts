/**
 * Pure decision functions for Redis key auto-refresh countdown.
 *
 * Extracted from RedisValueViewer.vue to enable unit testing of the
 * state-machine logic without mounting a Vue component.
 */

export const MIN_REDIS_AUTO_REFRESH_INTERVAL_SECONDS = 1;
export const MAX_REDIS_AUTO_REFRESH_INTERVAL_SECONDS = 3600;
export const DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS = 5;

/** Action computed after evaluating one visible TTL countdown tick. */
export type AutoRefreshTickAction = { type: "idle" } | { type: "decrement" };

/** Keep a user-entered polling frequency within a safe, whole-second range. */
export function normalizeRedisAutoRefreshInterval(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS;
  return Math.min(MAX_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, Math.floor(seconds)));
}

/**
 * Evaluate one one-second visible TTL countdown tick.
 *
 * @param enabled  Whether auto-refresh is currently toggled on.
 * @param countdownTtl  Current countdown value in seconds.
 * @returns The action the caller should take this tick.
 */
export function computeAutoRefreshTick(enabled: boolean, countdownTtl: number): AutoRefreshTickAction {
  return enabled && countdownTtl > 0 ? { type: "decrement" } : { type: "idle" };
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

/**
 * Choose the TTL used to initialize an expiry edit.
 *
 * A zero countdown can be a transient state while the final background refresh
 * is still in flight. Do not turn a last-confirmed positive Redis TTL into
 * PERSIST during that window.
 */
export function computeTtlForExpiryEdit(autoRefreshEnabled: boolean, countdownTtl: number, serverTtl: number): number {
  if (serverTtl <= 0) return serverTtl;
  const displayedTtl = computeDisplayTtl(autoRefreshEnabled, countdownTtl, serverTtl);
  return displayedTtl > 0 ? displayedTtl : serverTtl;
}
