import { isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { normalizeGlobalConnectTimeoutSecs, normalizeGlobalQueryTimeoutSecs } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

export function normalizeConnectionTimeouts(config: ConnectionConfig, connectTimeoutSecs: number, queryTimeoutSecs: number): void {
  config.connect_timeout_secs = config.connect_timeout_inherit === true ? normalizeGlobalConnectTimeoutSecs(connectTimeoutSecs) : normalizeGlobalConnectTimeoutSecs(config.connect_timeout_secs);
  const queryTimeout = Number(config.query_timeout_secs);
  config.query_timeout_secs = config.query_timeout_inherit === true ? normalizeGlobalQueryTimeoutSecs(queryTimeoutSecs) : normalizeGlobalQueryTimeoutSecs(queryTimeout);
  const idleTimeout = Number(config.idle_timeout_secs);
  config.idle_timeout_secs = Number.isFinite(idleTimeout) && idleTimeout >= 0 ? idleTimeout : 60;
  const keepaliveInterval = Number(config.keepalive_interval_secs);
  config.keepalive_interval_secs = Number.isFinite(keepaliveInterval) && keepaliveInterval >= 0 ? keepaliveInterval : 30;
}

export function normalizeConnectionScope(config: ConnectionConfig): void {
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
