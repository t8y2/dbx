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
// 空闲自动断开默认不启用（0）。上限取 86400（24 小时）：它对正常使用而言已是「几乎永不」
// 这类连接的时长上限，既避免写入离谱的大数（如把秒误填成毫秒），又足够覆盖长时间挂起的
// 空闲会话，不再沿用 idle_timeout 的 3600 以免过早关闭用户有意保留的连接池。
export const DEFAULT_IDLE_DISCONNECT_SECS = 0;
export const MAX_IDLE_DISCONNECT_SECS = 86400;
// 用户把「空闲自动断开」开关打开时填入的初值。取 300 秒（5 分钟）：既明显大于「保持连接间隔」
// 的默认 30 秒（否则一开启就落在保活之前、保活等于白开），又不至于长到让人以为没生效。
export const DEFAULT_IDLE_DISCONNECT_ENABLED_SECS = 300;

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

// 非法值/NaN/负数一律回落到默认 0（不启用），超出上限则截断；0 是合法值，需与非法值区分。
export function normalizeIdleDisconnectSecs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_IDLE_DISCONNECT_SECS;
  return Math.min(MAX_IDLE_DISCONNECT_SECS, Math.round(value));
}

export function supportsIdleTimeout(dbType?: DatabaseType): boolean {
  return dbType === "mongodb" || dbType === "mysql" || dbType === "doris" || dbType === "starrocks" || dbType === "manticoresearch";
}
