import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { dbPath as defaultDbPath } from "./paths.js";

export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: string;
  driver_profile?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  url_params?: string;
  ssh_enabled: boolean;
  ssh_tunnels?: SshTunnelConfig[];
  proxy_enabled?: boolean;
  proxy_type?: "socks5" | "http";
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
  ssl: boolean;
  ca_cert_path?: string;
  oracle_connection_type?: "service_name" | "sid";
  redis_connection_mode?: "standalone" | "sentinel";
  redis_sentinel_master?: string;
  redis_sentinel_nodes?: string;
  redis_sentinel_username?: string;
  redis_sentinel_password?: string;
  redis_sentinel_tls?: boolean;
}

export interface SshTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  host: string;
  port: number;
  user: string;
  password?: string;
  key_path?: string;
  key_passphrase?: string;
  connect_timeout_secs?: number;
  expose_lan?: boolean;
}

export interface ConnectionStoreOptions {
  path?: string;
}

export interface ConnectionStoreDiagnostics {
  dbPath: string;
  dbPathExists: boolean;
  connectionsTableExists: boolean;
  connectionSecretsTableExists: boolean;
  connectionRowCount: number;
  loadConnectionsOk: boolean;
  loadedConnectionCount: number;
  loadConnectionsError?: string;
}

export class ConnectionStoreError extends Error {
  readonly code = "CONNECTION_STORE_ERROR";

  constructor(path: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load DBX connections from ${path}: ${message}`);
    this.name = "ConnectionStoreError";
  }
}

export function canonicalizeConnection(config: ConnectionConfig): ConnectionConfig {
  if (config.db_type === "mysql" && config.driver_profile?.toLowerCase() === "tdengine") {
    return {
      ...config,
      db_type: "tdengine",
      driver_profile: "tdengine",
      port: config.port === 0 || config.port === 6030 ? 6041 : config.port,
    };
  }
  if (config.db_type === "tdengine") {
    return {
      ...config,
      driver_profile: "tdengine",
      port: config.port || 6041,
    };
  }
  return config;
}

function openDb(readonly = false, path = defaultDbPath()): Database.Database {
  return new Database(path, { readonly });
}

function getSecret(db: Database.Database, connectionId: string, key: string): string {
  const row = db
    .prepare("SELECT secret FROM connection_secrets WHERE connection_id = ? AND key = ?")
    .get(connectionId, key) as { secret: string } | undefined;
  return row?.secret ?? "";
}

export async function loadConnections(options: ConnectionStoreOptions = {}): Promise<ConnectionConfig[]> {
  const path = options.path ?? defaultDbPath();
  if (!existsSync(path)) return [];

  let db: Database.Database | undefined;
  try {
    db = openDb(true, path);
    const rows = db.prepare("SELECT id, config_json FROM connections").all() as { id: string; config_json: string }[];
    const configs: ConnectionConfig[] = [];

    for (const row of rows) {
      const config: ConnectionConfig = canonicalizeConnection(JSON.parse(row.config_json));
      config.id = row.id;
      if (!config.password) config.password = getSecret(db, row.id, "password");
      if (!config.proxy_password) config.proxy_password = getSecret(db, row.id, "proxy_password");
      if (!config.redis_sentinel_password) {
        config.redis_sentinel_password = getSecret(db, row.id, "redis_sentinel_password");
      }
      configs.push(config);
    }

    return configs;
  } catch (error) {
    throw new ConnectionStoreError(path, error);
  } finally {
    db?.close();
  }
}

export async function inspectConnectionStore(options: ConnectionStoreOptions = {}): Promise<ConnectionStoreDiagnostics> {
  const path = options.path ?? defaultDbPath();
  const diagnostics: ConnectionStoreDiagnostics = {
    dbPath: path,
    dbPathExists: existsSync(path),
    connectionsTableExists: false,
    connectionSecretsTableExists: false,
    connectionRowCount: 0,
    loadConnectionsOk: true,
    loadedConnectionCount: 0,
  };

  if (!diagnostics.dbPathExists) return diagnostics;

  let db: Database.Database | undefined;
  try {
    db = openDb(true, path);
    diagnostics.connectionsTableExists = tableExists(db, "connections");
    diagnostics.connectionSecretsTableExists = tableExists(db, "connection_secrets");
    if (diagnostics.connectionsTableExists) {
      const row = db.prepare("SELECT COUNT(*) AS count FROM connections").get() as { count: number };
      diagnostics.connectionRowCount = row.count;
    }
  } catch (error) {
    diagnostics.loadConnectionsOk = false;
    diagnostics.loadConnectionsError = error instanceof Error ? error.message : String(error);
    return diagnostics;
  } finally {
    db?.close();
  }

  try {
    const connections = await loadConnections({ path });
    diagnostics.loadedConnectionCount = connections.length;
  } catch (error) {
    diagnostics.loadConnectionsOk = false;
    diagnostics.loadConnectionsError = error instanceof Error ? error.message : String(error);
  }

  return diagnostics;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { "1": number } | undefined;
  return !!row;
}

export async function findConnection(name: string): Promise<ConnectionConfig | undefined> {
  const connections = await loadConnections();
  return connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export async function addConnection(config: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig> {
  const id = randomUUID();
  const db = openDb();
  const normalized = canonicalizeConnection({ ...config, id } as ConnectionConfig);

  const full = {
    id,
    name: normalized.name,
    db_type: normalized.db_type,
    driver_profile: normalized.driver_profile ?? normalized.db_type,
    driver_label: null,
    url_params: normalized.url_params ?? "",
    host: normalized.host,
    port: normalized.port,
    username: normalized.username,
    password: "",
    database: normalized.database ?? null,
    color: null,
    ssh_enabled: normalized.ssh_enabled ?? false,
    ssh_host: "",
    ssh_port: 22,
    ssh_user: "",
    ssh_password: "",
    ssh_key_path: "",
    ssh_key_passphrase: "",
    ssh_expose_lan: false,
    ssh_tunnels: normalized.ssh_tunnels ?? [],
    proxy_enabled: normalized.proxy_enabled ?? false,
    proxy_type: normalized.proxy_type ?? "socks5",
    proxy_host: normalized.proxy_host ?? "",
    proxy_port: normalized.proxy_port ?? 1080,
    proxy_username: normalized.proxy_username ?? "",
    proxy_password: "",
    ssl: normalized.ssl ?? false,
    sysdba: false,
    oracle_connection_type: normalized.oracle_connection_type ?? null,
    connection_string: null,
    redis_connection_mode: normalized.redis_connection_mode ?? "standalone",
    redis_sentinel_master: normalized.redis_sentinel_master ?? "",
    redis_sentinel_nodes: normalized.redis_sentinel_nodes ?? "",
    redis_sentinel_username: normalized.redis_sentinel_username ?? "",
    redis_sentinel_password: "",
    redis_sentinel_tls: normalized.redis_sentinel_tls ?? false,
  };
  const configJson = JSON.stringify(full);

  const insert = db.transaction(() => {
    db.prepare("INSERT INTO connections (id, config_json) VALUES (?, ?)").run(id, configJson);
    if (normalized.password) {
      db.prepare("INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)").run(
        id,
        "password",
        normalized.password,
      );
    }
    if (normalized.proxy_password) {
      db.prepare("INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)").run(
        id,
        "proxy_password",
        normalized.proxy_password,
      );
    }
    if (normalized.redis_sentinel_password) {
      db.prepare("INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)").run(
        id,
        "redis_sentinel_password",
        normalized.redis_sentinel_password,
      );
    }
  });
  insert();
  db.close();

  return normalized;
}

export async function removeConnection(name: string): Promise<boolean> {
  const connection = await findConnection(name);
  if (!connection) return false;

  const db = openDb();
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM connections WHERE id = ?").run(connection.id);
    db.prepare("DELETE FROM connection_secrets WHERE connection_id = ?").run(connection.id);
  });
  remove();
  db.close();

  return true;
}
