/**
 * Consent-gated read-only data queries for plugins (`host.data:read`, Host API 1.4).
 *
 * Mirrors `crates/dbx-core/src/query/plugin_data.rs`. The plugin sends one
 * read-only SQL statement for a connection; the host enforces the manifest
 * permission, the user's per-connection grant, the open-connection rule, the
 * read-only statement gate, and the row/byte caps.
 */

/** Permission required by `host.queryData`. */
export const PLUGIN_DATA_READ_PERMISSION = "host.data:read";

/** Capability advertised by the bridge when the host implements data queries. */
export const PLUGIN_DATA_CAPABILITY = "dataApi";

/** Error code prefix the backend uses for a missing or revoked grant. */
export const PLUGIN_DATA_ACCESS_NOT_GRANTED = "PLUGIN_DATA_ACCESS_NOT_GRANTED";

/** Mirrors the Rust-side bounds in plugin_data.rs. */
export const MAX_PLUGIN_DATA_SQL_CHARS = 100_000;
export const MAX_PLUGIN_DATA_MAX_ROWS = 5_000;
export const MAX_PLUGIN_DATA_NAME_CHARS = 256;
export const MAX_PLUGIN_DATA_TIMEOUT_MS = 60_000;

export interface PluginDataQueryRequest {
  connectionId: string;
  database?: string;
  schema?: string;
  sql: string;
  /** Default 500, capped at 5000 by the host. */
  maxRows?: number;
  /** Clamped to the connection timeout and a 60s host ceiling. */
  timeoutMs?: number;
}

export interface PluginDataColumn {
  name: string;
  dataType?: string;
}

export interface PluginDataQueryResult {
  dbType: string;
  columns: PluginDataColumn[];
  rows: unknown[][];
  /** True when rows were cut by the row cap, the byte cap, or the driver. */
  truncated: boolean;
  elapsedMs: number;
}

export interface PluginDataGrant {
  connectionId: string;
  /** Absent when the granted connection no longer exists. */
  connectionName?: string;
}
