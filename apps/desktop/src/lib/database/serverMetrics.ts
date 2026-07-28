/**
 * Engine-agnostic server-dashboard helpers shared by the MySQL and PostgreSQL
 * status modules: sample/rate math and human-readable formatting. Pure and
 * framework-free so they can be unit-tested in isolation.
 */

export type StatusMap = Record<string, string>;

export interface StatusSample {
  /** Capture time in epoch milliseconds (captured by the caller). */
  at: number;
  status: StatusMap;
}

/** A key/value row for the raw status table. */
export interface StatusEntry {
  name: string;
  value: string;
}

/** Read a status value as a number, defaulting to 0 when absent/non-numeric. */
export function statusNumber(status: StatusMap, key: string): number {
  const raw = status[key];
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-second rate of a cumulative counter between two samples. Guards against a
 * counter reset (server restart / stats reset) by treating a decrease as no
 * measurable rate, and against a zero/negative time delta.
 */
export function computeRate(prev: StatusSample, curr: StatusSample, key: string): number {
  const dtSeconds = (curr.at - prev.at) / 1000;
  if (dtSeconds <= 0) return 0;
  const delta = statusNumber(curr.status, key) - statusNumber(prev.status, key);
  if (delta < 0) return 0;
  return delta / dtSeconds;
}

/** Flatten a status map into sorted key/value rows for the raw table. */
export function statusEntries(status: StatusMap): StatusEntry[] {
  return Object.keys(status)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, value: status[name] }));
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

const RATE_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

/** Cumulative-counter rates can be below 1/s, so preserve their fractional value. */
export function formatRate(value: number): string {
  return Number.isFinite(value) ? RATE_NUMBER_FORMATTER.format(value) : "0";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

export function formatBytesPerSec(value: number): string {
  return `${formatBytes(value)}/s`;
}

/** Format an uptime in seconds as a compact `Nd Nh Nm` / `Nh Nm` / `Nm Ns` string. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
