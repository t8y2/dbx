import { join } from "node:path";
import { homedir, platform } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

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
  ssl: boolean;
}

function appDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "com.dbx.app");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "com.dbx.app");
    default:
      return join(home, ".config", "com.dbx.app");
  }
}

function openDb(readonly = false): Database.Database {
  const dbPath = join(appDataDir(), "dbx.db");
  return new Database(dbPath, { readonly });
}

function getSecret(db: Database.Database, connectionId: string, key: string): string {
  const row = db.prepare("SELECT secret FROM connection_secrets WHERE connection_id = ? AND key = ?").get(connectionId, key) as { secret: string } | undefined;
  return row?.secret ?? "";
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  try {
    const db = openDb(true);
    const rows = db.prepare("SELECT id, config_json FROM connections").all() as { id: string; config_json: string }[];
    const configs: ConnectionConfig[] = [];

    for (const row of rows) {
      const config: ConnectionConfig = JSON.parse(row.config_json);
      config.id = row.id;
      if (!config.password) config.password = getSecret(db, row.id, "password");
      configs.push(config);
    }

    db.close();
    return configs;
  } catch {
    return [];
  }
}

export async function findConnection(name: string): Promise<ConnectionConfig | undefined> {
  const connections = await loadConnections();
  return connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export async function addConnection(config: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig> {
  const id = randomUUID();
  const db = openDb();

  const sanitized = { ...config, id, password: "" };
  const configJson = JSON.stringify(sanitized);

  const insert = db.transaction(() => {
    db.prepare("INSERT INTO connections (id, config_json) VALUES (?, ?)").run(id, configJson);
    if (config.password) {
      db.prepare("INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)").run(id, "password", config.password);
    }
  });
  insert();
  db.close();

  return { ...config, id };
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
