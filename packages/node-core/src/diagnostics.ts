import { access, readFile } from "node:fs/promises";
import { bridgePortFilePath, dbPath, appDataDir } from "./paths.js";
import { inspectConnectionStore } from "./connections.js";

export const DIRECT_QUERY_TYPES = ["postgres", "redshift", "mysql", "doris", "starrocks", "sqlite", "rqlite", "gaussdb", "kwdb", "opengauss"] as const;

export type DirectQueryType = (typeof DIRECT_QUERY_TYPES)[number];

const DIRECT_QUERY_TYPE_SET = new Set<string>(DIRECT_QUERY_TYPES);

export function isDirectQueryType(dbType: string): dbType is DirectQueryType {
  return DIRECT_QUERY_TYPE_SET.has(dbType);
}

export const BRIDGE_REQUIRED_TYPES = [
  "redis",
  "mongodb",
  "duckdb",
  "clickhouse",
  "sqlserver",
  "oracle",
  "elasticsearch",
  "etcd",
  "dameng",
  "kingbase",
  "highgo",
  "vastbase",
  "goldendb",
  "databend",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "firebird",
  "exasol",
  "oceanbase-oracle",
  "gbase",
  "tdengine",
  "iotdb",
  "h2",
  "snowflake",
  "trino",
  "hive",
  "db2",
  "informix",
  "iris",
  "neo4j",
  "cassandra",
  "bigquery",
  "kylin",
  "sundb",
  "xugu",
  "jdbc",
  "access",
  "influxdb",
] as const;

export interface DbxDiagnostics {
  appDataDir: string;
  dbPath: string;
  dbPathExists: boolean;
  connectionsTableExists: boolean;
  connectionSecretsTableExists?: boolean;
  connectionRowCount: number;
  loadConnectionsOk: boolean;
  loadedConnectionCount: number;
  loadConnectionsError?: string;
  loadConnectionsHint?: string;
  bridgePortFile: string;
  bridgePortFileExists: boolean;
  bridgeUrl?: string;
  directQueryTypes: string[];
  bridgeRequiredTypes: string[];
}

export async function getDbxDiagnostics(): Promise<DbxDiagnostics> {
  const portFile = bridgePortFilePath();
  const bridgePortFileExists = await exists(portFile);
  let bridgeUrl: string | undefined;
  if (bridgePortFileExists) {
    const port = (await readFile(portFile, "utf-8")).trim();
    if (port) bridgeUrl = `http://127.0.0.1:${port}`;
  }

  const path = dbPath();
  const connectionStore = await inspectConnectionStore({ path });
  return {
    appDataDir: appDataDir(),
    dbPath: path,
    dbPathExists: connectionStore.dbPathExists,
    connectionsTableExists: connectionStore.connectionsTableExists,
    connectionSecretsTableExists: connectionStore.connectionSecretsTableExists,
    connectionRowCount: connectionStore.connectionRowCount,
    loadConnectionsOk: connectionStore.loadConnectionsOk,
    loadedConnectionCount: connectionStore.loadedConnectionCount,
    loadConnectionsError: connectionStore.loadConnectionsError,
    loadConnectionsHint: connectionStore.loadConnectionsError ? connectionStoreHint(connectionStore.loadConnectionsError) : undefined,
    bridgePortFile: portFile,
    bridgePortFileExists,
    bridgeUrl,
    directQueryTypes: [...DIRECT_QUERY_TYPES],
    bridgeRequiredTypes: [...BRIDGE_REQUIRED_TYPES],
  };
}

function connectionStoreHint(message: string): string | undefined {
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(message)) {
    return "Rebuild DBX CLI native dependencies with your active Node.js: pnpm rebuild better-sqlite3 keytar --pending, or reinstall the package with the same Node.js version you use to run dbx.";
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
