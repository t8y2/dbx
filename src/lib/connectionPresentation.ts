import type { ConnectionConfig } from "@/types/database";

type ConnectionPresentationConfig = Pick<
  ConnectionConfig,
  "db_type" | "driver_profile" | "driver_label" | "host" | "port" | "database"
>;

const LOCAL_DATABASE_TYPES = new Set(["sqlite", "duckdb"]);

export function connectionIconType(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile">): string {
  return connection?.driver_profile || connection?.db_type || "postgres";
}

export function connectionDriverLabel(connection?: Pick<ConnectionConfig, "db_type" | "driver_label">): string {
  return connection?.driver_label || connection?.db_type.toUpperCase() || "";
}

export function connectionEndpointLabel(connection?: ConnectionPresentationConfig): string {
  if (!connection) return "";
  if (LOCAL_DATABASE_TYPES.has(connection.db_type)) {
    return connection.host || connection.database || "local";
  }
  if (connection.host && connection.port) return `${connection.host}:${connection.port}`;
  return connection.host || connection.database || "";
}

export function connectionOptionSubtitle(connection?: ConnectionPresentationConfig): string {
  return [connectionDriverLabel(connection), connectionEndpointLabel(connection)].filter(Boolean).join(" · ");
}
