import { uuid } from "@/lib/common/utils";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import type { ConnectionConfig, ConnectionGroup, SidebarOrderEntry, TransportLayerConfig } from "@/types/database";

type RdmEntry = Record<string, unknown>;

function record(value: unknown): RdmEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RedisDesktopManager: invalid connection or group.");
  return value as RdmEntry;
}

function text(entry: RdmEntry, key: string, fallback = ""): string {
  const value = entry[key];
  if (value == null) return fallback;
  if (typeof value !== "string") throw new Error(`RedisDesktopManager: invalid ${key}.`);
  return value;
}

function flag(entry: RdmEntry, key: string): boolean {
  const value = entry[key];
  if (value == null || value === false || value === 0 || value === "false" || value === "0") return false;
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  throw new Error(`RedisDesktopManager: invalid ${key}.`);
}

function port(entry: RdmEntry, key: string, fallback: number): number {
  const value = entry[key];
  if (value == null || value === "") return fallback;
  const result = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`RedisDesktopManager: invalid ${key}.`);
  return result;
}

function timeout(entry: RdmEntry, key: string): number | undefined {
  const value = entry[key];
  if (value == null) return undefined;
  const result = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`RedisDesktopManager: invalid ${key}.`);
  return Math.ceil(result / 1000);
}

function connection(entry: RdmEntry): ConnectionConfig {
  const host = text(entry, "host").trim();
  if (!host || "db_type" in entry) throw new Error("RedisDesktopManager: expected an RDM connection with a host.");
  const redisPort = port(entry, "port", 6379);
  const ssl = flag(entry, "ssl");
  const clientCert = text(entry, "ssl_local_cert_path");
  const clientKey = text(entry, "ssl_private_key_path");
  if (ssl && !!clientCert !== !!clientKey) throw new Error("RedisDesktopManager: TLS client certificate and key must both be provided.");
  const connectTimeout = timeout(entry, "timeout_connect");
  const queryTimeout = timeout(entry, "timeout_execute");
  const config: ConnectionConfig = {
    id: uuid(),
    name: text(entry, "name").trim() || `${host}:${redisPort}`,
    db_type: "redis",
    driver_profile: "redis",
    driver_label: "Redis",
    host,
    port: redisPort,
    username: text(entry, "username"),
    password: text(entry, "auth"),
    ssl,
    ca_cert_path: text(entry, "ssl_ca_cert_path") || undefined,
    client_cert_path: clientCert || undefined,
    client_key_path: clientKey || undefined,
    save_password: true,
    redis_connection_mode: "standalone",
    redis_key_separator: text(entry, "namespace_separator", ":"),
    redis_key_filter: text(entry, "keys_pattern", "*"),
    ...(connectTimeout !== undefined ? { connect_timeout_secs: connectTimeout, connect_timeout_inherit: false } : {}),
    ...(queryTimeout !== undefined ? { query_timeout_secs: queryTimeout, query_timeout_inherit: false } : {}),
  };
  const sshHost = text(entry, "ssh_host").trim();
  if (sshHost) {
    const user = text(entry, "ssh_user").trim();
    if (!user) throw new Error("RedisDesktopManager: SSH username is required.");
    const password = text(entry, "ssh_password");
    const key = text(entry, "ssh_private_key_path");
    const agent = flag(entry, "ssh_agent");
    const layer: TransportLayerConfig = {
      id: uuid(),
      type: "ssh",
      enabled: true,
      host: sshHost,
      port: port(entry, "ssh_port", 22),
      user,
      password,
      key_path: key || undefined,
      use_ssh_agent: agent,
      ssh_agent_sock_path: text(entry, "ssh_agent_path") || undefined,
      auth_method: key ? (password ? "key+password" : "key") : agent ? "agent" : "password",
    };
    config.transport_layers = [layer];
  }
  return config;
}

export function parseRedisDesktopManagerImport(content: string): ConnectionConfigBundle {
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    throw new Error("RedisDesktopManager: invalid JSON file.");
  }
  if (!Array.isArray(input)) throw new Error("RedisDesktopManager: the export must be a JSON array.");
  const connections: ConnectionConfig[] = [];
  const groups: ConnectionGroup[] = [];
  const walk = (items: unknown[], depth: number): SidebarOrderEntry[] => {
    if (depth > 32) throw new Error("RedisDesktopManager: too many nested groups.");
    return items.map((value) => {
      const entry = record(value);
      if (entry.type === "group") {
        if (!Array.isArray(entry.connections)) throw new Error("RedisDesktopManager: a group must contain a connections array.");
        const name = text(entry, "name").trim();
        if (!name) throw new Error("RedisDesktopManager: group name is required.");
        const id = uuid();
        groups.push({ id, name, collapsed: false });
        return { type: "group", id, children: walk(entry.connections, depth + 1) };
      }
      if (entry.type != null && entry.type !== "connection") throw new Error("RedisDesktopManager: unsupported entry type.");
      const config = connection(entry);
      connections.push(config);
      return { type: "connection", id: config.id };
    });
  };
  const order = walk(input, 0);
  if (!connections.length) throw new Error("RedisDesktopManager: no connections found.");
  return { connections, ...(groups.length ? { layout: { groups, order } } : {}) };
}
