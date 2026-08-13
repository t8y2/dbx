import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { GAUSSDB_M_JDBC_DRIVER_PROFILE } from "@/lib/database/jdbcDialect";
import { parseGaussdbHosts, serializeGaussdbHosts } from "@/lib/connection/gaussdbHosts";

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
  if (connection.db_type === "cloudflare-d1") return [connection.host, connection.database].filter(Boolean).join("/");
  if (LOCAL_DATABASE_TYPES.has(connection.db_type) || (connection.db_type === "h2" && connection.port === 0)) {
    return connection.host || connection.database || "local";
  }
  const endpoint = normalizedPresentationEndpoint(connection);
  if (endpoint.host && endpoint.port) {
    // Multi-host format: host1:port1,host2:port2 — already includes ports
    if (endpoint.host.includes(",")) return endpoint.host;
    const endpointHost = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
    return `${endpointHost}:${endpoint.port}`;
  }
  return endpoint.host || connection.database || "";
}

function normalizedPresentationEndpoint(connection: ConnectionPresentationConfig): { host: string; port: number } {
  if (connection.db_type !== "gaussdb") return { host: connection.host, port: connection.port };
  return serializeGaussdbHosts(parseGaussdbHosts(connection.host, connection.port));
}

function redactConnectionHost(host: string): string {
  const normalizedHost = host.trim();
  if (!normalizedHost) return "";

  // Multi-host format: host1:port1,host2:port2 — redact each host separately
  // and replace each embedded port with the redacted marker.
  if (normalizedHost.includes(",")) {
    return normalizedHost
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx > 0) {
          return `${redactSingleHost(trimmed.slice(0, colonIdx))}:${REDACTED_PORT}`;
        }
        return redactSingleHost(trimmed);
      })
      .join(",");
  }

  return redactSingleHost(normalizedHost);
}

function redactSingleHost(host: string): string {
  const unwrappedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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
  if (connection.db_type === "cloudflare-d1") return `${REDACTED_HOST_SEGMENT}/${REDACTED_HOST_SEGMENT}`;
  if (LOCAL_DATABASE_TYPES.has(connection.db_type) || (connection.db_type === "h2" && connection.port === 0)) {
    return connectionEndpointLabel(connection);
  }

  const endpoint = normalizedPresentationEndpoint(connection);
  const redactedHost = endpoint.host ? redactConnectionHost(endpoint.host) : "";
  if (redactedHost && endpoint.port) {
    // Multi-host format already includes ports
    if (redactedHost.includes(",")) return redactedHost;
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

export function connectionDisplayUrlScheme(connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "ssl">>): string {
  switch (connection.db_type) {
    case "postgres":
    case "kwdb":
    case "yashandb":
    case "redshift":
    case "questdb":
      return "postgresql";
    case "gaussdb":
      return connection.driver_profile?.toLowerCase() === GAUSSDB_M_JDBC_DRIVER_PROFILE ? "jdbc:gaussdb" : "postgresql";
    case "sqlserver":
      return "mssql";
    case "elasticsearch":
    case "easysearch":
    case "meilisearch":
    case "qdrant":
    case "milvus":
    case "weaviate":
    case "chromadb":
    case "rqlite":
    case "turso":
    case "mq":
    case "consul":
      return connection.ssl ? "https" : "http";
    case "cloudflare-d1":
      return "https";
    case "dameng":
      return "dm";
    default:
      return connection.db_type;
  }
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
    case "questdb":
      return "postgresql://user:password@host:port/database";

    case "redis":
      return "redis://:password@host:port/0";

    case "etcd":
      return "etcd://host:2379";

    case "zookeeper":
      return "zookeeper://host:2181";

    case "consul":
      return "http://host:8500";

    case "sqlite":
      return "sqlite:///absolute/path/to/database.db";

    case "rqlite":
      return "http://user:password@host:4001";

    case "turso":
      return "https://[your-db]-[org].turso.io";

    case "cloudflare-d1":
      return "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}";

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
    case "easysearch":
    case "meilisearch":
    case "qdrant":
    case "milvus":
    case "weaviate":
    case "chromadb":
      return "http://user:password@host:port";

    case "dameng":
      return "dm://user:password@host:port";

    case "kingbase":
      return "kingbase8://user:password@host:54321/database";

    case "tdengine":
      return "tdengine://user:password@host:6041/database";

    case "oscar":
      return "oscar://user:password@host:2003/database";

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

    case "victoriametrics":
      return "http://user:password@host:port/prometheus";

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
