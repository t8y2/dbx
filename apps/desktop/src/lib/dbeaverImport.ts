import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { uuid } from "@/lib/utils";

type PartialConnection = Omit<ConnectionConfig, "id">;

type DbeaverImportPayload = {
  format: "dbeaver-import";
  dataSources: string;
  credentialsBase64?: string;
};

type DbeaverConnectionEntry = {
  id: string;
  name?: string;
  provider?: string;
  driver?: string;
  configuration?: Record<string, any>;
  [key: string]: any;
};

type ConnectionProfile = {
  dbType: DatabaseType;
  profile: string;
  label: string;
  port: number;
  user: string;
};

const dbeaverKey = new Uint8Array([186, 187, 74, 159, 119, 74, 184, 83, 201, 108, 45, 101, 61, 254, 84, 74]);

const profileMap: Record<string, ConnectionProfile> = {
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  sqlserver: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  mssql: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  duckdb: { dbType: "duckdb", profile: "duckdb", label: "DuckDB", port: 0, user: "" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  mongo: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  redshift: { dbType: "redshift", profile: "redshift", label: "Redshift", port: 5439, user: "awsuser" },
  elasticsearch: { dbType: "elasticsearch", profile: "elasticsearch", label: "Elasticsearch", port: 9200, user: "" },
  doris: { dbType: "doris", profile: "doris", label: "Doris", port: 9030, user: "root" },
  starrocks: { dbType: "starrocks", profile: "starrocks", label: "StarRocks", port: 9030, user: "root" },
  dameng: { dbType: "dameng", profile: "dm", label: "DM (Dameng)", port: 5236, user: "SYSDBA" },
  dm: { dbType: "dameng", profile: "dm", label: "DM (Dameng)", port: 5236, user: "SYSDBA" },
  gaussdb: { dbType: "gaussdb", profile: "gaussdb", label: "GaussDB", port: 5432, user: "gaussdb" },
  kwdb: { dbType: "kwdb", profile: "kwdb", label: "KWDB", port: 26257, user: "root" },
  opengauss: { dbType: "gaussdb", profile: "opengauss", label: "openGauss", port: 5432, user: "gaussdb" },
  influxdb: { dbType: "influxdb", profile: "influxdb", label: "InfluxDB", port: 8086, user: "" },
};

function normalizeKey(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function getNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function inferProfile(entry: DbeaverConnectionEntry): ConnectionProfile {
  const candidates = [entry.provider, entry.driver, entry.configuration?.url, entry.name].map(normalizeKey).join(" ");
  for (const [needle, profile] of Object.entries(profileMap)) {
    if (candidates.includes(needle)) return profile;
  }
  return { dbType: "jdbc", profile: "jdbc", label: getString(entry.driver) || "JDBC", port: 0, user: "" };
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decryptCredentialsFile(base64?: string): Promise<Record<string, Record<string, Record<string, string>>>> {
  if (!base64) return {};
  const bytes = base64ToBytes(base64);
  if (bytes.length <= 16) return {};

  try {
    const iv = bytes.slice(0, 16);
    const encrypted = bytes.slice(16);
    const cryptoKey = await crypto.subtle.importKey("raw", dbeaverKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encrypted);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return {};
  }
}

function readCredentials(entry: DbeaverConnectionEntry, credentials: Record<string, Record<string, Record<string, string>>>) {
  const secure = credentials[entry.id]?.["#connection"] || {};
  const inline = entry.configuration?.credentials || {};
  return {
    username: getString(secure.user || secure.username || inline.user || inline.username || entry.configuration?.user),
    password: getString(secure.password || inline.password || entry.configuration?.password),
  };
}

function parseJdbcUrl(url: string, profile: ConnectionProfile) {
  const result: {
    host?: string;
    port?: number;
    database?: string;
    params?: string;
    username?: string;
    password?: string;
    oracleConnectionType?: "service_name" | "sid";
  } = {};
  const source = url.trim();
  if (!source) return result;

  const withoutJdbc = source.replace(/^jdbc:/i, "");
  const sqlServerMatch = withoutJdbc.match(/^sqlserver:\/\/([^;:/]+)(?::(\d+))?(?:;(.*))?/i);
  if (sqlServerMatch) {
    result.host = sqlServerMatch[1];
    result.port = getNumber(sqlServerMatch[2]);
    for (const part of (sqlServerMatch[3] || "").split(";")) {
      const [key, ...rest] = part.split("=");
      const value = rest.join("=");
      if (/^(databasename|database)$/i.test(key)) result.database = value;
      else if (/^user$/i.test(key)) result.username = value;
      else if (/^password$/i.test(key)) result.password = value;
    }
    return result;
  }

  const oracleServiceMatch = withoutJdbc.match(/^oracle:thin:@\/\/([^:/]+)(?::(\d+))?\/([^?]+)/i);
  if (oracleServiceMatch) {
    result.host = oracleServiceMatch[1];
    result.port = getNumber(oracleServiceMatch[2]);
    result.database = oracleServiceMatch[3];
    result.oracleConnectionType = "service_name";
    return result;
  }

  const oracleSidMatch = withoutJdbc.match(/^oracle:thin:@([^:/]+)(?::(\d+))?:([^?]+)/i);
  if (oracleSidMatch) {
    result.host = oracleSidMatch[1];
    result.port = getNumber(oracleSidMatch[2]);
    result.database = oracleSidMatch[3];
    result.oracleConnectionType = "sid";
    return result;
  }

  const sqliteMatch = withoutJdbc.match(/^sqlite:(.+)$/i);
  if (sqliteMatch) {
    result.host = sqliteMatch[1];
    result.database = sqliteMatch[1];
    return result;
  }

  try {
    const parsed = new URL(withoutJdbc);
    result.host = parsed.hostname;
    result.port = parsed.port ? Number(parsed.port) : profile.port;
    result.database = parsed.pathname.replace(/^\/+/, "").split("/")[0] || undefined;
    result.params = parsed.search.replace(/^\?/, "");
    result.username = decodeURIComponent(parsed.username || "");
    result.password = decodeURIComponent(parsed.password || "");
  } catch {
    return result;
  }

  return result;
}

function extractConnections(parsed: any): DbeaverConnectionEntry[] {
  const source = parsed?.connections || parsed?.dataSources || parsed?.datasources || parsed;
  if (!source || typeof source !== "object") return [];

  if (Array.isArray(source)) {
    return source.filter((entry) => entry && typeof entry === "object").map((entry) => ({ ...entry, id: getString(entry.id || entry.uuid || entry.name) }));
  }

  return Object.entries(source)
    .filter(([, entry]) => entry && typeof entry === "object")
    .map(([id, entry]) => ({ ...(entry as Record<string, any>), id: getString((entry as any).id || id) }));
}

function buildConnection(entry: DbeaverConnectionEntry, credentials: ReturnType<typeof readCredentials>): ConnectionConfig | null {
  const profile = inferProfile(entry);
  const config = entry.configuration || {};
  const url = getString(config.url);
  const parsedUrl = parseJdbcUrl(url, profile);
  const host = getString(config.host || config["host-name"] || parsedUrl.host || (profile.dbType === "sqlite" ? "" : "127.0.0.1"));
  const database = getString(config.database || config["database-name"] || config.schema || parsedUrl.database);
  const name = getString(entry.name || database || host || profile.label);
  if (!entry.id || !name) return null;

  const partial: PartialConnection = {
    name,
    db_type: profile.dbType,
    driver_profile: profile.profile,
    driver_label: profile.label,
    url_params: getString(parsedUrl.params),
    host,
    port: getNumber(config.port || config["host-port"] || parsedUrl.port) || profile.port,
    username: credentials.username || getString(parsedUrl.username) || profile.user,
    password: credentials.password || getString(parsedUrl.password),
    database: database || undefined,
    color: getString(config.color || config["connection-color"]),
    transport_layers: [],
    connect_timeout_secs: 5,
    query_timeout_secs: 30,
    ssl: false,
    oracle_connection_type: profile.dbType === "oracle" ? parsedUrl.oracleConnectionType || "service_name" : undefined,
    connection_string: profile.dbType === "jdbc" || profile.dbType === "mongodb" ? url || undefined : undefined,
    jdbc_driver_class: profile.dbType === "jdbc" ? getString(config["driver-class"] || entry.driver) || undefined : undefined,
    jdbc_driver_paths: [],
  };

  return { ...partial, id: uuid() };
}

export function isDbeaverImportPayload(content: string) {
  try {
    const parsed = JSON.parse(content);
    return parsed?.format === "dbeaver-import";
  } catch {
    return false;
  }
}

export async function parseDbeaverConnections(content: string): Promise<ConnectionConfig[]> {
  const payload = JSON.parse(content) as DbeaverImportPayload;
  if (payload.format !== "dbeaver-import" || !payload.dataSources) {
    throw new Error("Invalid DBeaver import payload");
  }

  const dataSources = JSON.parse(payload.dataSources);
  const encryptedCredentials = await decryptCredentialsFile(payload.credentialsBase64);
  const configs: ConnectionConfig[] = [];
  const seen = new Set<string>();

  for (const entry of extractConnections(dataSources)) {
    const config = buildConnection(entry, readCredentials(entry, encryptedCredentials));
    if (!config) continue;
    const key = [config.name, config.db_type, config.host, config.port, config.database || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(config);
  }

  return configs;
}
