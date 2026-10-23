import type { ConnectionConfig, DatabaseType, TransportLayerConfig } from "@/types/database";
import { isCloudflareD1Connection } from "./cloudflareD1";

export type SshLocalPortState = "unset" | "valid" | "invalid";

function toPortNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN;
}

export function normalizeSshLocalPort(value: unknown): number | undefined {
  const port = toPortNumber(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export function sshLocalPortState(value: unknown): SshLocalPortState {
  if (value === undefined || value === null) return "unset";
  if (typeof value === "string" && value.trim() === "") return "unset";
  return normalizeSshLocalPort(value) === undefined ? "invalid" : "valid";
}

/** Like `normalizeSshLocalPort`, but keeps an out-of-range value as a number so form validation can report it. */
export function editableSshLocalPort(value: unknown): number | undefined {
  return sshLocalPortState(value) === "unset" ? undefined : toPortNumber(value);
}

// These types never bind the static tunnel on their primary path: SQLite reaches its remote worker over SSH, and
// ClickHouse, Turso and Cloudflare D1 route through a dynamic SOCKS5 port when SSH is the last layer.
const NO_STATIC_TUNNEL_DB_TYPES = new Set<DatabaseType>(["sqlite", "clickhouse", "turso"]);

type SshLocalPortConnection = Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "redis_connection_mode" | "external_config">>;

function isRocketMqConnection(config: SshLocalPortConnection, mqSystemKind?: string): boolean {
  if (config.db_type !== "mq") return false;
  const savedSystemKind = (config.external_config as { systemKind?: unknown } | undefined)?.systemKind;
  return (mqSystemKind ?? savedSystemKind ?? config.driver_profile) === "rocketmq";
}

/**
 * Whether the connection's primary tunnel can listen on a fixed local port (Redis Cluster and Sentinel route per node).
 * `mqSystemKind` is the message-queue kind picked in the form, which the backend reads from `external_config.systemKind`.
 */
export function sshLocalPortSupportedForConnection(config: SshLocalPortConnection, mqSystemKind?: string): boolean {
  if (NO_STATIC_TUNNEL_DB_TYPES.has(config.db_type) || isCloudflareD1Connection(config) || isRocketMqConnection(config, mqSystemKind)) return false;
  return config.db_type !== "redis" || (config.redis_connection_mode !== "cluster" && config.redis_connection_mode !== "sentinel");
}

export function withoutSshLocalPorts<T extends { transport_layers?: TransportLayerConfig[] }>(config: T): T {
  if (!config.transport_layers) return { ...config };
  return {
    ...config,
    transport_layers: config.transport_layers.map((layer) => {
      if (layer.type !== "ssh") return layer;
      const copy = { ...layer };
      delete copy.local_port;
      return copy;
    }),
  };
}
