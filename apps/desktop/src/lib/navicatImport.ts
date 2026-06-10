import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { uuid } from "@/lib/utils";

type PartialConnection = Omit<ConnectionConfig, "id">;

type ParsedNode = {
  tag: string;
  values: Record<string, string>;
};

const typeMap: Record<string, { dbType: DatabaseType; profile: string; label: string; port: number; user: string }> = {
  // String type identifiers (from Navicat ConnType / DatabaseType attributes)
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  sqlserver: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  mssql: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  redis: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  mongo: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  dameng: { dbType: "dameng", profile: "dm", label: "DM (Dameng)", port: 5236, user: "SYSDBA" },
  dm: { dbType: "dameng", profile: "dm", label: "DM (Dameng)", port: 5236, user: "SYSDBA" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  snowflake: { dbType: "snowflake", profile: "snowflake", label: "Snowflake", port: 443, user: "" },
  kingbase: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  kingbasees: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  gaussdb: { dbType: "gaussdb", profile: "gaussdb", label: "GaussDB", port: 8000, user: "root" },
  oceanbase: { dbType: "oceanbase-oracle", profile: "oceanbase", label: "OceanBase", port: 2881, user: "root" },
  // Numeric type codes (Navicat uses numeric ConnType for some exports)
  "1": { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  "2": { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  "3": { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  "4": { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  "5": { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  "7": { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  "8": { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  "9": { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
};

const unsupportedTypes = new Set(["http", "https", "ftp", "sftp", "ssh"]);

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAny(values: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = values[normalizeKey(key)];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function hexToBytes(hex: string) {
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

function stripPkcs7(bytes: Uint8Array) {
  const pad = bytes[bytes.length - 1];
  if (!pad || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

async function decryptNavicatPassword(value: string) {
  const encrypted = hexToBytes(value);
  if (!encrypted?.length) return "";

  const key = new TextEncoder().encode("libcckeylibcckey");
  const iv = new TextEncoder().encode("libcciv libcciv ");
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encrypted));
    return new TextDecoder().decode(stripPkcs7(decrypted));
  } catch {
    return "";
  }
}

function inferProfile(rawType: string, tag: string, port?: number) {
  const key = normalizeKey(rawType || tag);
  for (const [needle, profile] of Object.entries(typeMap)) {
    if (key.includes(needle)) return profile;
  }
  if (unsupportedTypes.has(key)) return null;
  // Port-based fallback for common default ports
  if (port) {
    if (port === 6379) return typeMap.redis;
    if (port === 27017) return typeMap.mongodb;
    if (port === 5432) return typeMap.postgresql;
    if (port === 3306) return typeMap.mysql;
    if (port === 1433) return typeMap.sqlserver;
    if (port === 1521) return typeMap.oracle;
  }
  return null;
}

function readNode(element: Element): ParsedNode {
  const values: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }

  for (const child of Array.from(element.children)) {
    const key = getAny(valuesFromElement(child), ["name", "key", "property", "field"]);
    const value = getAny(valuesFromElement(child), ["value", "val", "text", "data"]) || child.textContent?.trim() || "";
    if (key && value) values[normalizeKey(key)] = value;

    const tag = normalizeKey(child.tagName);
    const text = child.children.length === 0 ? child.textContent?.trim() || "" : "";
    if (text && !values[tag]) values[tag] = text;
    for (const attr of Array.from(child.attributes)) {
      values[`${tag}${normalizeKey(attr.name)}`] = attr.value;
    }
  }

  return { tag: element.tagName, values };
}

function valuesFromElement(element: Element) {
  const values: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }
  return values;
}

function isConnectionCandidate(node: ParsedNode) {
  const type = getAny(node.values, ["type", "connType", "connectionType", "databaseType", "driver"]);
  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]);
  const host = getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]);
  const file = getAny(node.values, ["databaseFile", "filename", "path", "databasePath"]);
  return !!(name || host || file) && !!(type || host || file);
}

async function parseConnection(node: ParsedNode): Promise<ConnectionConfig | null> {
  const rawType = getAny(node.values, ["type", "connType", "connectionType", "databaseType", "driver", "dbType"]);
  const portValue = Number(getAny(node.values, ["port", "serverPort"]));
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : undefined;
  const profile = inferProfile(rawType, node.tag, port);
  if (!profile) {
    const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || "(unnamed)";
    console.warn(`[Navicat Import] 跳过无法识别类型的连接: "${name}" (type="${rawType}", tag="${node.tag}", port=${port ?? "N/A"})`);
    return null;
  }

  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || getAny(node.values, ["host", "server", "hostname"]) || profile.label;
  const host = getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]) || getAny(node.values, ["databaseFile", "filename", "path", "databasePath"]) || (profile.dbType === "sqlite" ? "" : "127.0.0.1");
  const database = getAny(node.values, ["database", "databaseName", "initialDatabase", "serviceName", "sid", "schema"]);
  const oracleConnectionType = profile.dbType === "oracle" && getAny(node.values, ["sid"]) ? "sid" : profile.dbType === "oracle" ? "service_name" : undefined;
  const username = getAny(node.values, ["user", "username", "userName", "uid"]) || profile.user;
  const password = await decryptNavicatPassword(getAny(node.values, ["password"]));

  const config: PartialConnection = {
    name,
    db_type: profile.dbType,
    driver_profile: profile.profile,
    driver_label: profile.label,
    url_params: "",
    host,
    port: port || profile.port,
    username,
    password,
    database: database || undefined,
    color: "",
    transport_layers: [],
    connect_timeout_secs: 5,
    query_timeout_secs: 30,
    ssl: false,
    oracle_connection_type: oracleConnectionType,
    connection_string: undefined,
    jdbc_driver_class: undefined,
    jdbc_driver_paths: [],
  };

  return { ...config, id: uuid() };
}

export async function parseNavicatConnections(content: string): Promise<ConnectionConfig[]> {
  const doc = new DOMParser().parseFromString(content, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("Invalid Navicat connection file");

  const seen = new Set<string>();
  const configs: ConnectionConfig[] = [];
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const node = readNode(element);
    if (!isConnectionCandidate(node)) continue;
    const config = await parseConnection(node);
    if (!config) continue;
    const key = [config.name, config.db_type, config.host, config.port, config.database || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(config);
  }
  return configs;
}
