import { connectionHostIsFilePath } from "@/lib/connection/connectionFile";
import { sidebarProductionBadgeScope } from "@/lib/sidebar/sidebarProductionBadge";
import { normalizeIdleDisconnectSecs, normalizeIdleTimeoutSecs, normalizeManualTransactionTimeoutSecs } from "@/lib/connection/timeoutLimits";
import { isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { normalizeGlobalConnectTimeoutSecs, normalizeGlobalQueryTimeoutSecs } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

export function normalizeConnectionTimeouts(config: ConnectionConfig, connectTimeoutSecs: number, queryTimeoutSecs: number): void {
  config.connect_timeout_secs = config.connect_timeout_inherit === true ? normalizeGlobalConnectTimeoutSecs(connectTimeoutSecs) : normalizeGlobalConnectTimeoutSecs(config.connect_timeout_secs);
  const queryTimeout = Number(config.query_timeout_secs);
  config.query_timeout_secs = config.query_timeout_inherit === true ? normalizeGlobalQueryTimeoutSecs(queryTimeoutSecs) : normalizeGlobalQueryTimeoutSecs(queryTimeout);
  config.idle_timeout_secs = normalizeIdleTimeoutSecs(config.idle_timeout_secs);
  config.manual_transaction_timeout_secs = normalizeManualTransactionTimeoutSecs(config.manual_transaction_timeout_secs);
  config.idle_disconnect_secs = normalizeIdleDisconnectSecs(config.idle_disconnect_secs);
  const keepaliveInterval = Number(config.keepalive_interval_secs);
  config.keepalive_interval_secs = Number.isFinite(keepaliveInterval) && keepaliveInterval >= 0 ? keepaliveInterval : 30;
}

/**
 * Trim whitespace that can never be meaningful in connection identity fields.
 *
 * A copy-pasted hostname often carries a stray leading/trailing space; the driver then
 * fails with a "hostname resolve" error that hides the space, which makes the failure
 * very hard to diagnose (#12884). Hostnames, user names and database names tolerate no
 * surrounding whitespace.
 *
 * Two deliberate exceptions:
 * - `password` is never trimmed: surrounding spaces can be part of the credential.
 * - `host` carries the on-disk path for SQLite/DuckDB/Access, so those types keep it
 *   byte-exact.
 *
 * `port` is numeric on `ConnectionConfig`, so form whitespace is already parsed away.
 */
export function normalizeConnectionIdentityFields(config: ConnectionConfig): void {
  if (!connectionHostIsFilePath(config.db_type)) config.host = config.host.trim();
  config.username = config.username.trim();
  config.database = config.database?.trim() || undefined;
}

export function normalizeConnectionScope(config: ConnectionConfig): void {
  config.production_badge_scope = sidebarProductionBadgeScope(config);
  if (!config.one_time) config.one_time = undefined;
  if (!config.read_only) config.read_only = undefined;
  // Persist only an explicit opt-out; absent/true keeps the existing save-password behavior.
  config.save_password = config.save_password !== false;
  if ((isSingleDatabase(config.db_type) || config.db_type === "mq" || config.db_type === "mqtt") && config.production_databases?.length) {
    // These connection types do not expose independently selectable production databases.
    config.is_production = true;
    config.production_databases = [];
  }
  if (!config.is_production) config.is_production = undefined;
  config.production_databases = [...new Set((config.production_databases || []).map((database) => database.trim()).filter(Boolean))];
  if (!config.production_databases.length) config.production_databases = undefined;
}
