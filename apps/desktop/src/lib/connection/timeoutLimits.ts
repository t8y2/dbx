export const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
export const MAX_CONNECT_TIMEOUT_SECS = 300;
export const DEFAULT_QUERY_TIMEOUT_SECS = 30;
export const MAX_QUERY_TIMEOUT_SECS = 3600;

export function normalizeConnectTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONNECT_TIMEOUT_SECS;
  return Math.min(MAX_CONNECT_TIMEOUT_SECS, Math.max(1, Math.round(value)));
}

export function normalizeQueryTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUERY_TIMEOUT_SECS;
  return Math.min(MAX_QUERY_TIMEOUT_SECS, Math.max(0, Math.round(value)));
}
