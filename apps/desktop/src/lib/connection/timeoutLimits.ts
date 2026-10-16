import type { DatabaseType } from "@/types/database";

export const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
export const MAX_CONNECT_TIMEOUT_SECS = 300;
export const DEFAULT_QUERY_TIMEOUT_SECS = 60;
export const MAX_QUERY_TIMEOUT_SECS = 3600;
export const DEFAULT_IDLE_TIMEOUT_SECS = 60;
export const MAX_IDLE_TIMEOUT_SECS = 3600;
// Mirrors dbx-types: idle window of a manual transaction before DBX rolls it back.
export const DEFAULT_MANUAL_TRANSACTION_TIMEOUT_SECS = 300;
export const MIN_MANUAL_TRANSACTION_TIMEOUT_SECS = 30;
export const MAX_MANUAL_TRANSACTION_TIMEOUT_SECS = 86400;

export function normalizeConnectTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONNECT_TIMEOUT_SECS;
  return Math.min(MAX_CONNECT_TIMEOUT_SECS, Math.max(1, Math.round(value)));
}

export function normalizeQueryTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUERY_TIMEOUT_SECS;
  return Math.min(MAX_QUERY_TIMEOUT_SECS, Math.max(0, Math.round(value)));
}

export function normalizeIdleTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_IDLE_TIMEOUT_SECS;
  return Math.min(MAX_IDLE_TIMEOUT_SECS, Math.round(value));
}

export function normalizeManualTransactionTimeoutSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MANUAL_TRANSACTION_TIMEOUT_SECS;
  return Math.min(MAX_MANUAL_TRANSACTION_TIMEOUT_SECS, Math.max(MIN_MANUAL_TRANSACTION_TIMEOUT_SECS, Math.round(value)));
}

export function supportsIdleTimeout(dbType?: DatabaseType): boolean {
  return dbType === "mongodb" || dbType === "mysql" || dbType === "doris" || dbType === "starrocks" || dbType === "manticoresearch";
}
