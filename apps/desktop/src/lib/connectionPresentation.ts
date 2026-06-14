import type { ConnectionConfig, DatabaseType } from "@/types/database";

type ConnectionPresentationConfig = Pick<ConnectionConfig, "db_type" | "driver_profile" | "driver_label" | "host" | "port" | "database">;
type ConnectionNamePresentationConfig = ConnectionPresentationConfig & Pick<ConnectionConfig, "name">;

const LOCAL_DATABASE_TYPES = new Set(["sqlite", "duckdb", "access"]);
const REDACTED_HOST_SEGMENT = "***";
const REDACTED_PORT = "****";

export function connectionIconType(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile">): string {
  return connection?.driver_profile || connection?.db_type || "postgres";
}

export function connectionDriverLabel(connection?: Pick<ConnectionConfig, "db_type" | "driver_label">): string {
  return connection?.driver_label || connection?.db_type.toUpperCase() || "";
}

export function connectionEndpointLabel(connection?: ConnectionPresentationConfig): string {
  if (!connection) return "";
  if (LOCAL_DATABASE_TYPES.has(connection.db_type) || (connection.db_type === "h2" && connection.port === 0)) {
    return connection.host || connection.database || "local";
  }
  if (connection.host && connection.port) return `${connection.host}:${connection.port}`;
  return connection.host || connection.database || "";
}

function redactConnectionHost(host: string): string {
  const normalizedHost = host.trim();
  if (!normalizedHost) return "";

  const unwrappedHost = normalizedHost.startsWith("[") && normalizedHost.endsWith("]") ? normalizedHost.slice(1, -1) : normalizedHost;
  const separator = unwrappedHost.includes(":") ? ":" : ".";
  const segments = unwrappedHost.split(separator).filter(Boolean);

  if (segments.length >= 3) {
    return [segments[0], ...segments.slice(1, -1).map(() => REDACTED_HOST_SEGMENT), segments[segments.length - 1]].join(separator);
  }

  if (segments.length === 2) {
    return [segments[0], REDACTED_HOST_SEGMENT].join(separator);
  }

  return REDACTED_HOST_SEGMENT;
}

export function connectionRedactedEndpointLabel(connection?: ConnectionPresentationConfig): string {
  if (!connection) return "";
  if (LOCAL_DATABASE_TYPES.has(connection.db_type) || (connection.db_type === "h2" && connection.port === 0)) {
    return connectionEndpointLabel(connection);
  }

  const redactedHost = connection.host ? redactConnectionHost(connection.host) : "";
  if (redactedHost && connection.port) {
    const endpointHost = redactedHost.includes(":") ? `[${redactedHost}]` : redactedHost;
    return `${endpointHost}:${REDACTED_PORT}`;
  }

  return redactedHost || connection.database || "";
}

export function connectionRedactedNameLabel(connection?: ConnectionNamePresentationConfig): string {
  const name = connection?.name.trim() || "";
  if (!connection || !name || LOCAL_DATABASE_TYPES.has(connection.db_type) || (connection.db_type === "h2" && connection.port === 0)) return name;

  const host = connection.host.trim();
  if (!host) return name;

  const unwrappedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const hostNames = new Set([host, unwrappedHost]);
  if (connection.port) {
    hostNames.add(`${host}:${connection.port}`);
    if (unwrappedHost.includes(":")) {
      hostNames.add(`[${unwrappedHost}]:${connection.port}`);
    }
  }

  return hostNames.has(name) ? connectionRedactedEndpointLabel(connection) : name;
}

export function connectionUrlPlaceholder(dbType: DatabaseType): string {
  switch (dbType) {
    case "mysql":
    case "doris":
    case "starrocks":
    case "manticoresearch":
      return "mysql://user:password@host:port/database";

    case "postgres":
    case "gaussdb":
    case "kwdb":
    case "yashandb":
    case "redshift":
      return "postgresql://user:password@host:port/database";

    case "redis":
      return "redis://:password@host:port/0";

    case "etcd":
      return "etcd://host:2379";

    case "sqlite":
      return "sqlite:///absolute/path/to/database.db";

    case "rqlite":
      return "http://user:password@host:4001";

    case "turso":
      return "https://[your-db]-[org].turso.io";

    case "duckdb":
      return "duckdb:///absolute/path/to/database.duckdb";

    case "access":
      return "jdbc:ucanaccess:///absolute/path/to/database.accdb";

    case "mongodb":
      return "mongodb://user:password@host:port/database";

    case "clickhouse":
      return "clickhouse://user:password@host:port/database";

    case "sqlserver":
      return "mssql://user:password@host:port/database";

    case "oracle":
      return "oracle://user:password@host:port/service_name";

    case "elasticsearch":
      return "http://user:password@host:port";

    case "dameng":
      return "dm://user:password@host:port";

    case "tdengine":
      return "tdengine://user:password@host:6041/database";

    case "xugu":
      return "xugu://user:password@host:5138/database";

    case "iotdb":
      return "iotdb://user:password@host:6667/root.test";

    case "bigquery":
      return "bigquery://https://www.googleapis.com/bigquery/v2:443/project-id";

    case "iris":
      return "iris://user:password@host:port/namespace";

    case "influxdb":
      return "influxdb://user:password@host:port/database";

    case "jdbc":
      return "jdbc:mysql://host:3306/database";

    default:
      return "postgresql://user:password@host:port/database";
  }
}

export function connectionOptionSubtitle(connection?: ConnectionPresentationConfig): string {
  return [connectionDriverLabel(connection), connectionEndpointLabel(connection)].filter(Boolean).join(" · ");
}

export function connectionRedactedOptionSubtitle(connection?: ConnectionPresentationConfig): string {
  return [connectionDriverLabel(connection), connectionRedactedEndpointLabel(connection)].filter(Boolean).join(" · ");
}
