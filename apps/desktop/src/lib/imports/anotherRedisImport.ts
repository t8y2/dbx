import { uuid } from "@/lib/common/utils";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import type { ConnectionConfig, SidebarOrderEntry } from "@/types/database";

type Entry = Record<string, unknown>;
const prefix = "Another Redis Desktop Manager";
const fail = (field: string): never => {
  throw new Error(`${prefix}: invalid or unsupported ${field}.`);
};
function record(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("object");
  return value as Entry;
}
function text(entry: Entry, key: string, fallback = ""): string {
  const value = entry[key];
  return value == null ? fallback : typeof value === "string" ? value : fail(key);
}
function flag(entry: Entry, key: string): boolean {
  const value = entry[key];
  if (value == null || value === false) return false;
  return value === true ? true : fail(key);
}
function port(entry: Entry, fallback: number): number {
  const value = entry.port;
  if (value == null || value === "") return fallback;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fail("port");
}
function endpoint(host: string, value: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${value}`;
}
function connection(entry: Entry): ConnectionConfig {
  const host = text(entry, "host").trim();
  if (!host || "db_type" in entry) return fail("host");
  if (entry.natMap != null && Object.keys(record(entry.natMap)).length) return fail("NAT mapping");
  const redisPort = port(entry, 6379);
  const cluster = flag(entry, "cluster");
  const sentinel = entry.sentinelOptions == null ? undefined : record(entry.sentinelOptions);
  if (cluster && sentinel) return fail("combined Sentinel/Cluster mode");
  const config: ConnectionConfig = {
    id: uuid(),
    name: text(entry, "name").trim() || endpoint(host, redisPort),
    db_type: "redis",
    driver_profile: "redis",
    driver_label: "Redis",
    host,
    port: redisPort,
    username: text(entry, "username"),
    password: text(entry, "auth"),
    save_password: true,
    read_only: flag(entry, "connectionReadOnly"),
    redis_key_separator: text(entry, "separator", ":"),
    redis_connection_mode: sentinel ? "sentinel" : cluster ? "cluster" : "standalone",
    ssl: entry.sslOptions != null,
  };
  if (cluster) config.redis_cluster_nodes = endpoint(host, redisPort);
  if (sentinel) {
    const master = text(sentinel, "masterName").trim();
    if (!master) return fail("Sentinel masterName");
    config.redis_sentinel_master = master;
    config.redis_sentinel_nodes = endpoint(host, redisPort);
    config.redis_sentinel_password = config.password;
    config.password = text(sentinel, "nodePassword");
  }
  if (entry.sslOptions != null) {
    const tls = record(entry.sslOptions);
    if (text(tls, "servername")) return fail("TLS servername override");
    config.ca_cert_path = text(tls, "ca") || undefined;
    config.client_cert_path = text(tls, "cert") || undefined;
    config.client_key_path = text(tls, "key") || undefined;
    if (!!config.client_cert_path !== !!config.client_key_path) return fail("TLS certificate/key pair");
  }
  if (entry.sshOptions != null) {
    const ssh = record(entry.sshOptions);
    const sshHost = text(ssh, "host").trim();
    const user = text(ssh, "username");
    if (!sshHost || !user.trim()) return fail("SSH host/username");
    const password = text(ssh, "password");
    const key = text(ssh, "privatekey");
    if (ssh.timeout != null && typeof ssh.timeout !== "number" && typeof ssh.timeout !== "string") return fail("SSH timeout");
    const timeout = ssh.timeout == null ? 30 : Number(ssh.timeout);
    if (!Number.isInteger(timeout) || timeout <= 0) return fail("SSH timeout");
    config.transport_layers = [
      {
        id: uuid(),
        type: "ssh",
        enabled: true,
        host: sshHost,
        port: port(ssh, 22),
        user,
        password,
        key_path: key || undefined,
        key_passphrase: text(ssh, "passphrase") || undefined,
        auth_method: key ? (password ? "key+password" : "key") : "password",
        connect_timeout_secs: timeout,
      },
    ];
  }
  return config;
}

/** Official .ano exports are UTF-8 JSON wrapped in Base64, not encrypted backups. */
export function parseAnotherRedisImport(content: string): ConnectionConfigBundle {
  if (content.length > 16 * 1024 * 1024) return fail("file size (maximum 16 MiB)");
  const encoded = content.trim().replace(/\s/g, "");
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) return fail("Base64 export");
  let input: unknown;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("UTF-8 JSON export");
  }
  const bundle = Array.isArray(input) ? { connections: input, groups: [] } : record(input);
  const entries = bundle.connections;
  const groupEntries = bundle.groups ?? [];
  if (!Array.isArray(entries) || !entries.length || entries.length > 10000 || !Array.isArray(groupEntries) || groupEntries.length > 10000) return fail("connections/groups");
  const groups: NonNullable<ConnectionConfigBundle["layout"]>["groups"] = [];
  const groupIds = new Map<string, string>();
  const children = new Map<string, SidebarOrderEntry[]>();
  for (const value of groupEntries) {
    const entry = record(value);
    const originalId = text(entry, "id");
    const name = text(entry, "name");
    if (!originalId || !name.trim() || groupIds.has(originalId)) return fail("group identity/name");
    const id = uuid();
    groups.push({ id, name, collapsed: false });
    groupIds.set(originalId, id);
    children.set(id, []);
  }
  const connections: ConnectionConfig[] = [];
  const ungrouped: SidebarOrderEntry[] = [];
  for (const value of entries) {
    const entry = record(value);
    const config = connection(entry);
    connections.push(config);
    const group = groupIds.get(text(entry, "groupId"));
    (group ? children.get(group)! : ungrouped).push({ type: "connection", id: config.id });
  }
  const order: SidebarOrderEntry[] = [...groups.map(({ id }) => ({ type: "group" as const, id, children: children.get(id)! })), ...ungrouped];
  return { connections, ...(groups.length ? { layout: { groups, order } } : {}) };
}
