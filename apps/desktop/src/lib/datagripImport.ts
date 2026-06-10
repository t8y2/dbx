import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { uuid } from "@/lib/utils";

declare var process: { env: Record<string, string | undefined> } | undefined;

type PartialConnection = Omit<ConnectionConfig, "id">;

export type DataGripImportPayload = {
  format: "datagrip-import";
  dataSources: string;
  dataSourcesLocal?: string;
};

type DataSourceFragment = {
  uuid: string;
  name: string;
  driverRef: string;
  jdbcUrl: string;
  driverClass: string;
  username: string;
  product: string;
  groupName?: string;
};

type DriverProfile = {
  dbType: DatabaseType;
  profile: string;
  label: string;
  port: number;
  user: string;
};

// driver-ref prefix → dbx profile
const driverRefMap: Record<string, DriverProfile> = {
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  sqlserver: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  mssql: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  jtds: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  mongo: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  redis: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  cassandra: { dbType: "cassandra", profile: "cassandra", label: "Cassandra", port: 9042, user: "" },
  duckdb: { dbType: "duckdb", profile: "duckdb", label: "DuckDB", port: 0, user: "" },
  bigquery: { dbType: "bigquery", profile: "bigquery", label: "BigQuery", port: 443, user: "" },
  cockroach: { dbType: "postgres", profile: "cockroachdb", label: "CockroachDB", port: 26257, user: "root" },
  cockroachdb: { dbType: "postgres", profile: "cockroachdb", label: "CockroachDB", port: 26257, user: "root" },
  redshift: { dbType: "redshift", profile: "redshift", label: "Redshift", port: 5439, user: "awsuser" },
  elasticsearch: { dbType: "elasticsearch", profile: "elasticsearch", label: "Elasticsearch", port: 9200, user: "" },
  h2: { dbType: "h2", profile: "h2", label: "H2", port: 9092, user: "sa" },
  snowflake: { dbType: "snowflake", profile: "snowflake", label: "Snowflake", port: 443, user: "" },
};

// product name from <database-info product="..."> → dbx profile
const productMap: Record<string, DriverProfile> = {
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  "sql server": { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  redis: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  cassandra: { dbType: "cassandra", profile: "cassandra", label: "Cassandra", port: 9042, user: "" },
  duckdb: { dbType: "duckdb", profile: "duckdb", label: "DuckDB", port: 0, user: "" },
  bigquery: { dbType: "bigquery", profile: "bigquery", label: "BigQuery", port: 443, user: "" },
  redshift: { dbType: "redshift", profile: "redshift", label: "Redshift", port: 5439, user: "awsuser" },
  elasticsearch: { dbType: "elasticsearch", profile: "elasticsearch", label: "Elasticsearch", port: 9200, user: "" },
  snowflake: { dbType: "snowflake", profile: "snowflake", label: "Snowflake", port: 443, user: "" },
};

// JDBC subprotocol → dbx profile (fallback when driver-ref and product are unknown)
const subprotocolMap: Record<string, DriverProfile> = {
  mysql: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  mariadb: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  sqlite: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
  sqlserver: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  jtds: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  oracle: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  mongodb: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  redis: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  clickhouse: { dbType: "clickhouse", profile: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  cassandra: { dbType: "cassandra", profile: "cassandra", label: "Cassandra", port: 9042, user: "" },
  duckdb: { dbType: "duckdb", profile: "duckdb", label: "DuckDB", port: 0, user: "" },
  bigquery: { dbType: "bigquery", profile: "bigquery", label: "BigQuery", port: 443, user: "" },
  redshift: { dbType: "redshift", profile: "redshift", label: "Redshift", port: 5439, user: "awsuser" },
};

function getNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getText(element: Element, tagName: string): string {
  const child = element.getElementsByTagName(tagName)[0];
  return child?.textContent?.trim() ?? "";
}

function expandPathMacros(value: string): string {
  if (typeof window !== "undefined") {
    const home = (typeof process !== "undefined" && process.env?.HOME) || (typeof process !== "undefined" && process.env?.USERPROFILE) || "";
    if (home) return value.replace(/\$USER_HOME\$/g, home);
  }
  return value.replace(/\$USER_HOME\$/g, "~");
}

// --- JDBC URL parser ---

function parseJdbcUrl(jdbcUrl: string): {
  host: string;
  port: number;
  database: string;
  oracleConnectionType?: "service_name" | "sid";
} {
  const url = jdbcUrl.replace(/^jdbc:/i, "").trim();
  const result = {
    host: "",
    port: 0,
    database: "",
    oracleConnectionType: undefined as "service_name" | "sid" | undefined,
  };

  // SQL Server: jdbc:sqlserver://host[:port][;key=value]
  const sqlServerMatch = url.match(/^sqlserver:\/\/([^;:/]+)(?::(\d+))?(?:;(.*))?/i);
  if (sqlServerMatch) {
    result.host = sqlServerMatch[1];
    result.port = getNumber(sqlServerMatch[2]);
    for (const part of (sqlServerMatch[3] || "").split(";")) {
      const [key, ...rest] = part.split("=");
      if (/^(databasename|database)$/i.test(key)) result.database = rest.join("=");
    }
    return result;
  }

  // Oracle thin with service_name: jdbc:oracle:thin:@//host:port/service
  const oracleService = url.match(/^oracle:thin:@\/\/([^:/]+)(?::(\d+))?\/([^?]+)/i);
  if (oracleService) {
    result.host = oracleService[1];
    result.port = getNumber(oracleService[2]);
    result.database = oracleService[3];
    result.oracleConnectionType = "service_name";
    return result;
  }

  // Oracle thin with SID: jdbc:oracle:thin:@host:port:sid
  const oracleSid = url.match(/^oracle:thin:@([^:/]+)(?::(\d+))?:([^?]+)/i);
  if (oracleSid) {
    result.host = oracleSid[1];
    result.port = getNumber(oracleSid[2]);
    result.database = oracleSid[3];
    result.oracleConnectionType = "sid";
    return result;
  }

  // SQLite / DuckDB file path: jdbc:sqlite:path/to/file.db
  const fileMatch = url.match(/^(sqlite|duckdb):(.+)$/i);
  if (fileMatch) {
    result.host = expandPathMacros(fileMatch[2].split("?")[0]);
    result.database = result.host;
    return result;
  }

  // BigQuery: jdbc:bigquery://host;ProjectId=xxx
  const bigqueryMatch = url.match(/^bigquery:\/\/([^;]+)(?:;(.+))?/i);
  if (bigqueryMatch) {
    result.host = bigqueryMatch[1];
    for (const part of (bigqueryMatch[2] || "").split(";")) {
      const [key, ...rest] = part.split("=");
      if (/^(projectid|project)$/i.test(key)) result.database = rest.join("=");
    }
    return result;
  }

  // Generic authority form: jdbc:<sub>://[user[:pass]@]host[:port][/database][?params]
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return result;

  let remainder = url.slice(schemeEnd + 3);
  remainder = remainder.split("?")[0];

  const slashIndex = remainder.indexOf("/");
  const authority = (slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder).split("@").pop() || "";
  const database = slashIndex >= 0 ? remainder.slice(slashIndex + 1) : "";

  const firstHost = authority.split(",")[0] || authority;
  if (firstHost.startsWith("[")) {
    const closing = firstHost.indexOf("]");
    if (closing > 0) {
      result.host = firstHost.slice(1, closing);
      if (firstHost[closing + 1] === ":") result.port = getNumber(firstHost.slice(closing + 2));
    }
  } else {
    const lastColon = firstHost.lastIndexOf(":");
    if (lastColon > 0) {
      result.host = firstHost.slice(0, lastColon);
      result.port = getNumber(firstHost.slice(lastColon + 1));
    } else {
      result.host = firstHost;
    }
  }

  result.database = database;
  return result;
}

function extractSubprotocol(jdbcUrl: string): string {
  const url = jdbcUrl.trim();
  if (!url.toLowerCase().startsWith("jdbc:")) return "";
  let subprotocol = "";
  for (const char of url.slice(5)) {
    if (char === ":" || char === "/") break;
    subprotocol += char;
  }
  return subprotocol;
}

function inferProfile(driverRef: string, subprotocol: string, driverClass: string, product: string): DriverProfile {
  // 1. Try driver-ref prefix (most specific)
  const refKey = driverRef.split(".")[0].toLowerCase();
  if (driverRefMap[refKey]) return driverRefMap[refKey];

  // 2. Try product name from <database-info>
  const productKey = product.toLowerCase();
  for (const [needle, profile] of Object.entries(productMap)) {
    if (productKey.includes(needle)) return profile;
  }

  // 3. Try JDBC subprotocol
  const subKey = subprotocol.toLowerCase();
  if (subprotocolMap[subKey]) return subprotocolMap[subKey];

  // 4. Try driver class name
  const classLower = driverClass.toLowerCase();
  if (classLower.includes("mysql")) return driverRefMap.mysql;
  if (classLower.includes("postgres")) return driverRefMap.postgresql;
  if (classLower.includes("sqlite")) return driverRefMap.sqlite;
  if (classLower.includes("oracle")) return driverRefMap.oracle;
  if (classLower.includes("sqlserver") || classLower.includes("mssql")) return driverRefMap.sqlserver;
  if (classLower.includes("mongo")) return driverRefMap.mongodb;
  if (classLower.includes("redis")) return driverRefMap.redis;
  if (classLower.includes("clickhouse")) return driverRefMap.clickhouse;

  // 5. Fallback to JDBC
  return { dbType: "jdbc", profile: "jdbc", label: driverClass || "JDBC", port: 0, user: "" };
}

// --- XML parsing ---

function parseDataSourcesXml(xml: string): Map<string, Partial<DataSourceFragment>> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return new Map();

  const result = new Map<string, Partial<DataSourceFragment>>();
  const elements = doc.getElementsByTagName("data-source");

  for (const element of Array.from(elements)) {
    const uuidVal = element.getAttribute("uuid");
    if (!uuidVal) continue;

    const fragment: Partial<DataSourceFragment> = {
      uuid: uuidVal,
      name: element.getAttribute("name") || undefined,
    };

    const driverRef = getText(element, "driver-ref");
    if (driverRef) fragment.driverRef = driverRef;

    const jdbcUrl = getText(element, "jdbc-url");
    if (jdbcUrl) fragment.jdbcUrl = jdbcUrl;

    const driverClass = getText(element, "jdbc-driver");
    if (driverClass) fragment.driverClass = driverClass;

    const userName = getText(element, "user-name");
    if (userName) fragment.username = userName;

    const groupName = element.getAttribute("group-name") || undefined;
    if (groupName) fragment.groupName = groupName;

    result.set(uuidVal, fragment);
  }

  return result;
}

function parseDataSourcesLocalXml(xml: string): Map<string, Partial<DataSourceFragment>> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return new Map();

  const result = new Map<string, Partial<DataSourceFragment>>();
  const elements = doc.getElementsByTagName("data-source");

  for (const element of Array.from(elements)) {
    const uuidVal = element.getAttribute("uuid");
    if (!uuidVal) continue;

    const fragment: Partial<DataSourceFragment> = {
      uuid: uuidVal,
      name: element.getAttribute("name") || undefined,
    };

    const userName = getText(element, "user-name");
    if (userName) fragment.username = userName;

    // Extract product from <database-info product="...">
    const dbInfo = element.getElementsByTagName("database-info")[0];
    const product = dbInfo?.getAttribute("product") || "";
    if (product) fragment.product = product;

    result.set(uuidVal, fragment);
  }

  return result;
}

function mergeFragments(shared: Map<string, Partial<DataSourceFragment>>, local: Map<string, Partial<DataSourceFragment>>): DataSourceFragment[] {
  const merged = new Map<string, Partial<DataSourceFragment>>();

  // Shared first (has driver-ref, jdbc-url, group-name)
  for (const [uuidVal, frag] of shared) {
    merged.set(uuidVal, { ...frag });
  }

  // Merge local (has user-name, product — overrides name if present)
  for (const [uuidVal, localFrag] of local) {
    const existing = merged.get(uuidVal) || { uuid: uuidVal };
    merged.set(uuidVal, {
      ...existing,
      ...localFrag,
      // Keep shared name if local has it too (they're usually the same)
      name: existing.name || localFrag.name,
      // Keep shared driver-ref and jdbc-url (local doesn't have these)
      driverRef: existing.driverRef || localFrag.driverRef,
      jdbcUrl: existing.jdbcUrl || localFrag.jdbcUrl,
      driverClass: existing.driverClass || localFrag.driverClass,
      groupName: existing.groupName || localFrag.groupName,
    });
  }

  // Resolve and filter
  const resolved: DataSourceFragment[] = [];
  for (const frag of merged.values()) {
    if (!frag.uuid || !frag.driverRef || !frag.jdbcUrl) continue;
    resolved.push({
      uuid: frag.uuid,
      name: frag.name || frag.uuid,
      driverRef: frag.driverRef,
      jdbcUrl: frag.jdbcUrl,
      driverClass: frag.driverClass || "",
      username: frag.username || "",
      product: frag.product || "",
      groupName: frag.groupName,
    });
  }

  return resolved;
}

function buildConnection(fragment: DataSourceFragment): ConnectionConfig {
  const subprotocol = extractSubprotocol(fragment.jdbcUrl);
  const profile = inferProfile(fragment.driverRef, subprotocol, fragment.driverClass, fragment.product);
  const parsed = parseJdbcUrl(fragment.jdbcUrl);

  const host = parsed.host || (profile.dbType === "sqlite" ? "" : "127.0.0.1");
  const port = parsed.port || profile.port;
  const database = parsed.database || undefined;
  const username = fragment.username || profile.user;
  const name = fragment.name || database || host || profile.label;

  const partial: PartialConnection = {
    name,
    db_type: profile.dbType,
    driver_profile: profile.profile,
    driver_label: profile.label,
    url_params: "",
    host,
    port,
    username,
    password: "",
    database,
    color: "",
    transport_layers: [],
    connect_timeout_secs: 5,
    query_timeout_secs: 30,
    ssl: false,
    oracle_connection_type: profile.dbType === "oracle" ? parsed.oracleConnectionType || "service_name" : undefined,
    connection_string: profile.dbType === "jdbc" || profile.dbType === "mongodb" ? fragment.jdbcUrl.replace(/^jdbc:/i, "") : undefined,
    jdbc_driver_class: profile.dbType === "jdbc" ? fragment.driverClass || undefined : undefined,
    jdbc_driver_paths: [],
  };

  return { ...partial, id: uuid() };
}

// --- Public API ---

export function isDataGripImportPayload(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.format === "datagrip-import";
  } catch {
    return false;
  }
}

export function parseDataGripConnections(payload: DataGripImportPayload): ConnectionConfig[] {
  const shared = parseDataSourcesXml(payload.dataSources);
  const local = payload.dataSourcesLocal ? parseDataSourcesLocalXml(payload.dataSourcesLocal) : new Map();
  const fragments = mergeFragments(shared, local);

  const configs: ConnectionConfig[] = [];
  const seen = new Set<string>();

  for (const fragment of fragments) {
    const config = buildConnection(fragment);
    const key = [config.name, config.db_type, config.host, config.port, config.database || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(config);
  }

  return configs;
}

/** Returns a map of dedup key (name\0host\0port\0db) → DataGrip UUID for Keychain lookup. */
export function getDataGripUuidMap(payload: DataGripImportPayload): Map<string, string> {
  const shared = parseDataSourcesXml(payload.dataSources);
  const local = payload.dataSourcesLocal ? parseDataSourcesLocalXml(payload.dataSourcesLocal) : new Map();
  const fragments = mergeFragments(shared, local);

  const uuidMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const fragment of fragments) {
    const profile = inferProfile(fragment.driverRef, extractSubprotocol(fragment.jdbcUrl), fragment.driverClass, fragment.product);
    const parsed = parseJdbcUrl(fragment.jdbcUrl);
    const host = parsed.host || (profile.dbType === "sqlite" ? "" : "127.0.0.1");
    const port = parsed.port || profile.port;
    const database = parsed.database || "";
    const name = fragment.name || database || host || profile.label;
    const dedupKey = [name, host, port, database].join("\u0000");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    uuidMap.set(dedupKey, fragment.uuid);
  }

  return uuidMap;
}

/** Build the macOS Keychain service name for a DataGrip data source UUID. */
export function datagripKeychainService(uuid: string): string {
  return `IntelliJ Platform DB — ${uuid}`;
}
