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

// The HTML number input grammar (a valid floating-point number), so anything the field can display parses as a number.
const FLOATING_POINT_NUMBER = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * Keeps a finite number, even an out-of-range one, so form validation can report it. Anything else is unset: a number
 * input shows it as empty, and an empty-looking field must not fail validation.
 */
export function editableSshLocalPort(value: unknown): number | undefined {
  const port = typeof value === "string" && FLOATING_POINT_NUMBER.test(value) ? Number(value) : value;
  return typeof port === "number" && Number.isFinite(port) ? port : undefined;
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
 * `pluginProxyRoute` is the selected plugin provider's `proxy_route` flag: those providers connect through a SOCKS5 route.
 */
export function sshLocalPortSupportedForConnection(config: SshLocalPortConnection, mqSystemKind?: string, pluginProxyRoute?: boolean): boolean {
  if (NO_STATIC_TUNNEL_DB_TYPES.has(config.db_type) || isCloudflareD1Connection(config) || isRocketMqConnection(config, mqSystemKind)) return false;
  if (config.db_type === "plugin" && pluginProxyRoute === true) return false;
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
