import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { filterDatabaseNamesForConnection, normalizeVisibleDatabaseSelection } from "@/lib/visibleDatabases";

const DRAFT_VISIBLE_DATABASES_PREFIX = "__visible_draft_";

const UNSUPPORTED_VISIBLE_DATABASE_TYPES = new Set<DatabaseType>(["elasticsearch", "etcd"]);

type VisibleDatabaseConnectionFields = Pick<
  ConnectionConfig,
  "db_type" | "driver_profile" | "host" | "port" | "username" | "database" | "connection_string" | "url_params" | "redis_connection_mode" | "redis_sentinel_master" | "redis_sentinel_nodes" | "redis_cluster_nodes" | "etcd_endpoints" | "jdbc_driver_class"
>;

export function buildDraftVisibleDatabasesConnectionId(seed: string): string {
  return `${DRAFT_VISIBLE_DATABASES_PREFIX}${seed}`;
}

export function connectionCanChooseVisibleDatabases(connection: Pick<ConnectionConfig, "db_type"> | undefined): boolean {
  return !!connection?.db_type && !UNSUPPORTED_VISIBLE_DATABASE_TYPES.has(connection.db_type);
}

export function initialVisibleDatabaseSelection(databaseNames: string[], visibleDatabases: string[] | undefined, connection?: Pick<ConnectionConfig, "db_type" | "driver_profile" | "visible_databases">): string[] {
  if (Array.isArray(visibleDatabases)) {
    return normalizeVisibleDatabaseSelection(visibleDatabases, databaseNames);
  }
  return filterDatabaseNamesForConnection(databaseNames, connection);
}

export function visibleDatabaseSelectionIsStale(previous: VisibleDatabaseConnectionFields, current: VisibleDatabaseConnectionFields): boolean {
  return visibleDatabaseFingerprint(previous) !== visibleDatabaseFingerprint(current);
}

function visibleDatabaseFingerprint(connection: VisibleDatabaseConnectionFields): string {
  return JSON.stringify({
    db_type: connection.db_type,
    driver_profile: connection.driver_profile || "",
    host: connection.host || "",
    port: Number(connection.port) || 0,
    username: connection.username || "",
    database: connection.database || "",
    connection_string: connection.connection_string || "",
    url_params: connection.url_params || "",
    redis_connection_mode: connection.redis_connection_mode || "",
    redis_sentinel_master: connection.redis_sentinel_master || "",
    redis_sentinel_nodes: connection.redis_sentinel_nodes || "",
    redis_cluster_nodes: connection.redis_cluster_nodes || "",
    etcd_endpoints: connection.etcd_endpoints || "",
    jdbc_driver_class: connection.jdbc_driver_class || "",
  });
}
