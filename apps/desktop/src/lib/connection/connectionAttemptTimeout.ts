import type { ConnectionConfig, DatabaseType } from "@/types/database";

export const CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS = 2_000;
export const MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS = 30_000;
export const AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS = 30;
export const ACCESS_AGENT_MIN_CONNECT_TIMEOUT_SECS = 30;
const DEFAULT_CONNECT_TIMEOUT_SECS = 10;

const DRIVER_STARTUP_FLOOR_TYPES = new Set<DatabaseType>([
  "dameng",
  "kingbase",
  "highgo",
  "vastbase",
  "goldendb",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "firebird",
  "exasol",
  "oceanbase-oracle",
  "gbase",
  "access",
  "oracle",
  "h2",
  "snowflake",
  "trino",
  "prestosql",
  "jdbc",
  "hive",
  "spark",
  "db2",
  "informix",
  "neo4j",
  "cassandra",
  "bigquery",
  "kylin",
  "sundb",
  "oscar",
  "tdengine",
  "xugu",
  "iotdb",
  "etcd",
  "zookeeper",
  "iris",
]);

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function connectionAttemptTimeoutMs(config: Pick<ConnectionConfig, "connect_timeout_secs" | "transport_layers"> & Partial<Pick<ConnectionConfig, "db_type">>): number {
  const baseTimeoutSecs = positiveSeconds(config.connect_timeout_secs, DEFAULT_CONNECT_TIMEOUT_SECS);
  const agentMinTimeoutSecs = config.db_type === "access" ? ACCESS_AGENT_MIN_CONNECT_TIMEOUT_SECS : AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS;
  const timeouts = [DRIVER_STARTUP_FLOOR_TYPES.has(config.db_type as DatabaseType) ? Math.max(baseTimeoutSecs, agentMinTimeoutSecs) : baseTimeoutSecs];
  for (const layer of config.transport_layers ?? []) {
    if (layer.enabled === false) continue;
    if (layer.type === "ssh" || layer.type === "http_tunnel") {
      timeouts.push(positiveSeconds(layer.connect_timeout_secs, DEFAULT_CONNECT_TIMEOUT_SECS));
    }
  }
  const fallbackBuffer = config.db_type === "mongodb" ? MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS : 0;
  return Math.ceil(Math.max(...timeouts) * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS + fallbackBuffer);
}

export function connectionAttemptTimeoutMessage(timeoutMs: number): string {
  return `Connection attempt timed out after ${Math.ceil(timeoutMs / 1000)}s. Please check the network or VPN and try again.`;
}

export function connectionAttemptOriginalErrorMessage(timeoutMessage: string, originalMessage: string): string {
  const message = originalMessage.trim();
  if (!message || message === timeoutMessage) return timeoutMessage;
  return `${timeoutMessage}\n\nOriginal database error returned after the UI timeout:\n${message}`;
}
