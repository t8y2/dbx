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
export type TtlCountdownTickAction = { type: "idle" } | { type: "decrement" };

/** Keep a user-entered polling frequency within a safe, whole-second range. */
export function normalizeRedisAutoRefreshInterval(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS;
  return Math.min(MAX_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, Math.floor(seconds)));
}

/**
 * Evaluate one one-second visible TTL countdown tick.
 *
 * @param countdownTtl  Current countdown value in seconds.
 * @returns The action the caller should take this tick.
 */
export function computeTtlCountdownTick(countdownTtl: number): TtlCountdownTickAction {
  return countdownTtl > 0 ? { type: "decrement" } : { type: "idle" };
}

/** Compute a TTL countdown from the time the server value was observed. */
export function computeTtlCountdownValue(serverTtl: number, observedAtMs: number, nowMs: number): number {
  if (serverTtl <= 0) return serverTtl;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - observedAtMs) / 1000));
  return Math.max(serverTtl - elapsedSeconds, 0);
}

/**
 * Compute the TTL value that should be displayed in the badge.
 *
 * The local countdown is independent from automatic network refreshes, so the
 * last known server TTL must not reappear after the countdown reaches zero.
 */
export function computeDisplayTtl(countdownTtl: number, serverTtl: number): number {
  return serverTtl > 0 ? Math.max(countdownTtl, 0) : serverTtl;
}

/**
 * Choose the TTL used to initialize an expiry edit.
 *
 * A zero countdown can be a transient state while the final background refresh
 * is still in flight. Do not turn a last-confirmed positive Redis TTL into
 * PERSIST during that window.
 */
export function computeTtlForExpiryEdit(countdownTtl: number, serverTtl: number): number {
  if (serverTtl <= 0) return serverTtl;
  const displayedTtl = computeDisplayTtl(countdownTtl, serverTtl);
  return displayedTtl > 0 ? displayedTtl : serverTtl;
}
