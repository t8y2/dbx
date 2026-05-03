import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

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

const KEYRING_SERVICE = "dev.dbx.connections";

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

async function getKeytarSecret(connectionId: string, key: string): Promise<string | null> {
  try {
    const keytar = await import("keytar");
    return await keytar.default.getPassword(KEYRING_SERVICE, `connection:${connectionId}:${key}`);
  } catch {
    return null;
  }
}

async function getFileSecret(connectionId: string, key: string): Promise<string | null> {
  try {
    const secretsPath = join(appDataDir(), "secrets.json");
    const data = JSON.parse(await readFile(secretsPath, "utf-8"));
    return data[`connection:${connectionId}:${key}`] ?? null;
  } catch {
    return null;
  }
}

async function getSecret(connectionId: string, key: string): Promise<string> {
  const fromKeyring = await getKeytarSecret(connectionId, key);
  if (fromKeyring) return fromKeyring;
  const fromFile = await getFileSecret(connectionId, key);
  return fromFile ?? "";
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  const configPath = join(appDataDir(), "connections.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const configs: ConnectionConfig[] = JSON.parse(raw);
    for (const config of configs) {
      if (!config.password) config.password = await getSecret(config.id, "password");
    }
    return configs;
  } catch {
    return [];
  }
}

export async function findConnection(name: string): Promise<ConnectionConfig | undefined> {
  const connections = await loadConnections();
  return connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
}
