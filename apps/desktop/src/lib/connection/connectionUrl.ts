import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { h2JdbcUrlHasPasswordParam, h2JdbcUrlHasUserParam, parseH2JdbcUrl } from "@/lib/database/h2Connection";

export interface ParsedConnectionUrl {
  name?: string;
  dbType: DatabaseType;
  driverProfile: string;
  driverLabel: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  urlParams: string;
  ssl: boolean;
  connectionString?: string;
  oracleConnectionType?: "service_name" | "sid";
  useMongoUrl?: boolean;
  portExplicit?: boolean;
}

export type ConnectionProfile = {
  type: DatabaseType;
  profile: string;
  label: string;
  defaultPort: number;
};

const SCHEME_PROFILES: Record<string, ConnectionProfile> = {
  mysql: { type: "mysql", profile: "mysql", label: "MySQL", defaultPort: 3306 },
  mariadb: { type: "mysql", profile: "mariadb", label: "MariaDB", defaultPort: 3306 },
  postgres: { type: "postgres", profile: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  postgresql: { type: "postgres", profile: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  redshift: { type: "redshift", profile: "redshift", label: "Redshift", defaultPort: 5439 },
  redis: { type: "redis", profile: "redis", label: "Redis", defaultPort: 6379 },
  rediss: { type: "redis", profile: "redis", label: "Redis", defaultPort: 6379 },
  etcd: { type: "etcd", profile: "etcd", label: "etcd", defaultPort: 2379 },
  zookeeper: { type: "zookeeper", profile: "zookeeper", label: "Apache ZooKeeper", defaultPort: 2181 },
  mongodb: { type: "mongodb", profile: "mongodb", label: "MongoDB", defaultPort: 27017 },
  "mongodb+srv": { type: "mongodb", profile: "mongodb", label: "MongoDB", defaultPort: 27017 },
  clickhouse: { type: "clickhouse", profile: "clickhouse", label: "ClickHouse", defaultPort: 8123 },
  sqlserver: { type: "sqlserver", profile: "sqlserver", label: "SQL Server", defaultPort: 1433 },
  mssql: { type: "sqlserver", profile: "sqlserver", label: "SQL Server", defaultPort: 1433 },
  oracle: { type: "oracle", profile: "oracle", label: "Oracle", defaultPort: 1521 },
  elasticsearch: { type: "elasticsearch", profile: "elasticsearch", label: "Elasticsearch", defaultPort: 9200 },
  qdrant: { type: "qdrant", profile: "qdrant", label: "Qdrant", defaultPort: 6333 },
  milvus: { type: "milvus", profile: "milvus", label: "Milvus", defaultPort: 19530 },
  weaviate: { type: "weaviate", profile: "weaviate", label: "Weaviate", defaultPort: 8080 },
  chromadb: { type: "chromadb", profile: "chromadb", label: "ChromaDB", defaultPort: 8000 },
  dm: { type: "dameng", profile: "dm", label: "DM (Dameng)", defaultPort: 5236 },
  dameng: { type: "dameng", profile: "dm", label: "DM (Dameng)", defaultPort: 5236 },
  gaussdb: { type: "gaussdb", profile: "gaussdb", label: "GaussDB", defaultPort: 5432 },
  kwdb: { type: "kwdb", profile: "kwdb", label: "KWDB", defaultPort: 26257 },
  gbase: { type: "gbase", profile: "gbase", label: "GBase", defaultPort: 5258 },
  "gbasedbt-sqli": { type: "gbase", profile: "gbase8s", label: "GBase 8s", defaultPort: 9088 },
  "informix-sqli": { type: "informix", profile: "informix", label: "Informix", defaultPort: 9088 },
  yashandb: { type: "yashandb", profile: "yashandb", label: "YashanDB", defaultPort: 1688 },
  opengauss: { type: "gaussdb", profile: "opengauss", label: "openGauss", defaultPort: 5432 },
  questdb: { type: "questdb", profile: "questdb", label: "QuestDB", defaultPort: 8812 },
  tdengine: { type: "tdengine", profile: "tdengine", label: "TDengine", defaultPort: 6041 },
  "taos-ws": { type: "tdengine", profile: "tdengine", label: "TDengine", defaultPort: 6041 },
  oscar: { type: "oscar", profile: "oscar", label: "神通 OSCAR", defaultPort: 2003 },
  xugu: { type: "xugu", profile: "xugu", label: "XuguDB", defaultPort: 5138 },
  iotdb: { type: "iotdb", profile: "iotdb", label: "Apache IoTDB", defaultPort: 6667 },
  iris: { type: "iris", profile: "iris", label: "IRIS", defaultPort: 1972 },
};

const HTTP_SELECTED_PROFILES: Record<string, ConnectionProfile> = {
  clickhouse: SCHEME_PROFILES.clickhouse,
  elasticsearch: SCHEME_PROFILES.elasticsearch,
  qdrant: SCHEME_PROFILES.qdrant,
  milvus: SCHEME_PROFILES.milvus,
  weaviate: SCHEME_PROFILES.weaviate,
  chromadb: SCHEME_PROFILES.chromadb,
};

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodePercentEscapes(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function encodeMongoUserInfoPart(value: string): string {
  return encodeURIComponent(decodePercentEscapes(value));
}

export function normalizeMongoConnectionString(value: string): string {
  const input = value.trim();
  if (!input) return input;

  const mongoMatch = input.match(/^(mongodb(?:\+srv)?):\/\/(?:(.+)@)?/i);
  if (!mongoMatch) return input;

  const userinfo = mongoMatch[2];
  if (!userinfo) return input;

  const [username, ...passwordParts] = userinfo.split(":");
  const password = passwordParts.join(":");
  const encodedUsername = encodeMongoUserInfoPart(username);
  const encodedPassword = password ? `:${encodeMongoUserInfoPart(password)}` : "";

  return input.replace(/^(mongodb(?:\+srv)?:\/\/)(?:(.+)@)?/i, `$1${encodedUsername}${encodedPassword}@`);
}

function parseMongoUrl(source: string): ParsedConnectionUrl | null {
  const match = source.match(/^(mongodb(?:\+srv)?):\/\/(?:(.+)@)?([^/]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const userinfo = match[2] || "";
  const hosts = match[3] || "";
  const pathname = match[4] || "";
  const search = match[5] || "";

  const profile = SCHEME_PROFILES[scheme];
  if (!profile) return null;

  const [username, ...passwordParts] = decodeUrlPart(userinfo).split(":");
  const password = passwordParts.join(":");

  const firstHost = hosts.split(",")[0];
  let host: string;
  let port: number;
  if (firstHost.startsWith("[")) {
    const bracketEnd = firstHost.indexOf("]");
    host = firstHost.substring(1, bracketEnd);
    port = firstHost.substring(bracketEnd + 1).startsWith(":") ? Number(firstHost.substring(bracketEnd + 2)) || profile.defaultPort : profile.defaultPort;
  } else if (firstHost.includes(":")) {
    const colonIdx = firstHost.lastIndexOf(":");
    host = firstHost.substring(0, colonIdx);
    port = Number(firstHost.substring(colonIdx + 1)) || profile.defaultPort;
  } else {
    host = firstHost;
    port = profile.defaultPort;
  }

  const database = databaseFromPath(pathname);
  const urlParams = search.replace(/^\?/, "");

  return {
    dbType: profile.type,
    driverProfile: profile.profile,
    driverLabel: profile.label,
    host,
    port,
    username,
    password,
    database,
    urlParams,
    ssl: scheme === "mongodb+srv",
    connectionString: normalizeMongoConnectionString(source),
    useMongoUrl: true,
  };
}

function databaseFromPath(pathname: string): string | undefined {
  const value = pathname.replace(/^\/+/, "");
  if (!value) return undefined;
  return decodeUrlPart(value.split("/")[0]);
}

function queryParamValue(params: string, key: string): string | undefined {
  for (const part of params.split(/[&;]/)) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    if (decodeUrlPart(rawKey).toLowerCase() === key.toLowerCase()) {
      return decodeUrlPart(rest.join("=")).trim();
    }
  }
  return undefined;
}

function connectionNameParam(parsed: URL): string | undefined {
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === "name") {
      const name = value.trim();
      if (name) return name;
    }
  }
  return undefined;
}

function stripConnectionNameParam(params: string): string {
  if (!params) return params;
  return params
    .split("&")
    .filter((part) => {
      if (!part) return true;
      const [rawKey] = part.split("=");
      return decodeUrlPart(rawKey).trim().toLowerCase() !== "name";
    })
    .join("&");
}

function extractMysqlCredentialParams(params: string): { username?: string; password?: string; urlParams: string } {
  let username: string | undefined;
  let password: string | undefined;
  let foundCredentialParam = false;
  const urlParams: string[] = [];

  for (const part of params.split(/[&;]/)) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    const key = decodeUrlPart(rawKey).trim().toLowerCase();
    if (key === "user") {
      username = decodeUrlPart(rest.join("=")).trim();
      foundCredentialParam = true;
    } else if (key === "password") {
      password = decodeUrlPart(rest.join("=")).trim();
      foundCredentialParam = true;
    } else {
      urlParams.push(part);
    }
  }

  return { username, password, urlParams: foundCredentialParam ? urlParams.join("&") : params };
}

function urlParamsRequireTls(dbType: DatabaseType, params: string): boolean {
  if (dbType === "mysql") {
    const requireSsl = queryParamValue(params, "require_ssl")?.toLowerCase();
    if (requireSsl === "true" || requireSsl === "1" || requireSsl === "yes") return true;
    const sslMode = (queryParamValue(params, "ssl-mode") || queryParamValue(params, "sslmode") || "").toLowerCase().replace("-", "_");
    return sslMode === "required" || sslMode === "require" || sslMode === "verify_ca" || sslMode === "verify_identity";
  }

  if (dbType === "postgres" || dbType === "redshift" || dbType === "kwdb") {
    const sslMode = (queryParamValue(params, "sslmode") || "").toLowerCase();
    return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
  }

  return false;
}

function isTidbCloudHost(host: string): boolean {
  return host.toLowerCase().endsWith(".tidbcloud.com");
}

export function connectionProfileForScheme(scheme: string, preferredProfile?: string): ConnectionProfile | undefined {
  if ((scheme === "http" || scheme === "https") && preferredProfile) {
    return HTTP_SELECTED_PROFILES[preferredProfile];
  }
  return SCHEME_PROFILES[scheme];
}

function parseJdbcSqlServerUrl(source: string): ParsedConnectionUrl | null {
  const match = source.match(/^jdbc:sqlserver:\/\/([^;:/]+)(?::(\d+))?(?:;(.*))?$/i);
  if (!match) return null;

  const profile = SCHEME_PROFILES.sqlserver;
  const props = new Map<string, string>();
  const urlParams: string[] = [];
  for (const part of (match[3] || "").split(";")) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey.trim();
    const value = rest.join("=");
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "databasename" || normalizedKey === "database" || normalizedKey === "user") {
      props.set(normalizedKey, value);
    } else if (normalizedKey === "password") {
      props.set(normalizedKey, value);
    } else {
      urlParams.push(part);
    }
  }

  return {
    dbType: profile.type,
    driverProfile: profile.profile,
    driverLabel: profile.label,
    host: match[1],
    port: match[2] ? Number(match[2]) : profile.defaultPort,
    ...(match[2] ? { portExplicit: true } : {}),
    username: decodeUrlPart(props.get("user") || ""),
    password: decodeUrlPart(props.get("password") || ""),
    database: decodeUrlPart(props.get("databasename") || props.get("database") || "") || undefined,
    urlParams: urlParams.join(";"),
    ssl: false,
  };
}

function parseJdbcOracleUrl(source: string): ParsedConnectionUrl | null {
  const descriptorMatch = source.match(/^jdbc:oracle:thin:@\s*\((.+)\)\s*$/i);
  if (descriptorMatch) {
    const profile = SCHEME_PROFILES.oracle;
    const host = oracleDescriptorValue(source, "HOST");
    const port = oracleDescriptorValue(source, "PORT");
    const serviceName = oracleDescriptorValue(source, "SERVICE_NAME");
    const sid = oracleDescriptorValue(source, "SID");
    if (!host) return null;
    return {
      dbType: profile.type,
      driverProfile: profile.profile,
      driverLabel: profile.label,
      host,
      port: port ? Number(port) : profile.defaultPort,
      username: "",
      password: "",
      database: serviceName || sid || undefined,
      urlParams: "",
      ssl: false,
      connectionString: source,
      oracleConnectionType: sid && !serviceName ? "sid" : "service_name",
    };
  }

  const serviceMatch = source.match(/^jdbc:oracle:thin:@\/\/([^:/?#]+)(?::(\d+))?\/([^?]+)(?:\?(.*))?$/i);
  if (serviceMatch) {
    const profile = SCHEME_PROFILES.oracle;
    return {
      dbType: profile.type,
      driverProfile: profile.profile,
      driverLabel: profile.label,
      host: serviceMatch[1],
      port: serviceMatch[2] ? Number(serviceMatch[2]) : profile.defaultPort,
      username: "",
      password: "",
      database: decodeUrlPart(serviceMatch[3]),
      urlParams: serviceMatch[4] || "",
      ssl: false,
      oracleConnectionType: "service_name",
    };
  }

  const sidMatch = source.match(/^jdbc:oracle:thin:@([^:/?#]+)(?::(\d+))?:([^?]+)(?:\?(.*))?$/i);
  if (sidMatch) {
    const profile = SCHEME_PROFILES.oracle;
    return {
      dbType: profile.type,
      driverProfile: profile.profile,
      driverLabel: profile.label,
      host: sidMatch[1],
      port: sidMatch[2] ? Number(sidMatch[2]) : profile.defaultPort,
      username: "",
      password: "",
      database: decodeUrlPart(sidMatch[3]),
      urlParams: sidMatch[4] || "",
      ssl: false,
      oracleConnectionType: "sid",
    };
  }

  return null;
}

function oracleDescriptorValue(source: string, key: string): string | undefined {
  const match = new RegExp(`\\(${key}\\s*=\\s*([^\\)]+)\\)`, "i").exec(source);
  return match?.[1]?.trim();
}

function parseJdbcUCanAccessUrl(source: string): ParsedConnectionUrl | null {
  const match = source.match(/^jdbc:ucanaccess:\/\/(.+?)(?:;.*)?$/i);
  if (!match) return null;

  const filePath = decodeUrlPart(match[1]);
  const normalizedPath = filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath) ? filePath : `/${filePath}`;
  const database = normalizedPath.split(/[\\/]/).filter(Boolean).pop();

  return {
    dbType: "access",
    driverProfile: "access",
    driverLabel: "Microsoft Access",
    host: normalizedPath,
    port: 0,
    username: "",
    password: "",
    database,
    urlParams: "",
    ssl: false,
    connectionString: source,
  };
}

function parseJdbcGbase8sUrl(source: string): ParsedConnectionUrl | null {
  const match = /^jdbc:gbasedbt-sqli:\/\/(?:(?<userinfo>[^@/?#]*)@)?(?<host>\[[^\]]+\]|[^:/?#]+)(?::(?<port>\d+))?\/(?<database>[^:?#]*)(?::(?<params>[^?#]*))?/i.exec(source);
  if (!match?.groups) return null;

  const rawUserInfo = match.groups.userinfo || "";
  const [rawUser = "", ...passwordParts] = rawUserInfo.split(":");
  const host = match.groups.host.replace(/^\[/, "").replace(/\]$/, "");

  return {
    dbType: "gbase",
    driverProfile: "gbase8s",
    driverLabel: "GBase 8s",
    host,
    port: match.groups.port ? Number(match.groups.port) : 9088,
    username: decodeUrlPart(rawUser),
    password: decodeUrlPart(passwordParts.join(":")),
    database: decodeUrlPart(match.groups.database || ""),
    urlParams: match.groups.params || "",
    ssl: false,
  };
}

function parseJdbcInformixUrl(source: string): ParsedConnectionUrl | null {
  const match = /^jdbc:informix-sqli:\/\/(?:(?<userinfo>[^@/?#]*)@)?(?<host>\[[^\]]+\]|[^:/?#]+)(?::(?<port>\d+))?\/(?<database>[^:?#]*)(?::(?<params>[^?#]*))?/i.exec(source);
  if (!match?.groups) return null;

  const rawUserInfo = match.groups.userinfo || "";
  const [rawUser = "", ...passwordParts] = rawUserInfo.split(":");
  const host = match.groups.host.replace(/^\[/, "").replace(/\]$/, "");

  return {
    dbType: "informix",
    driverProfile: "informix",
    driverLabel: "Informix",
    host,
    port: match.groups.port ? Number(match.groups.port) : 9088,
    username: decodeUrlPart(rawUser),
    password: decodeUrlPart(passwordParts.join(":")),
    database: decodeUrlPart(match.groups.database || ""),
    urlParams: match.groups.params || "",
    ssl: false,
  };
}

function parseJdbcDremioUrl(source: string): ParsedConnectionUrl | null {
  const match = /^jdbc:dremio:(?<mode>direct|zk)=(?<host>\[[^\]]+\]|[^:;]+)(?::(?<port>\d+))?(?:;(?<params>.*))?$/i.exec(source);
  if (!match?.groups) return null;

  const props = new Map<string, string>();
  const urlParams: string[] = [];
  for (const part of (match.groups.params || "").split(";")) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey.trim();
    const value = rest.join("=");
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "schema" || normalizedKey === "user" || normalizedKey === "password") {
      props.set(normalizedKey, value);
    } else {
      urlParams.push(part);
    }
  }

  return {
    dbType: "jdbc",
    driverProfile: "dremio",
    driverLabel: "Dremio",
    host: match.groups.host.replace(/^\[/, "").replace(/\]$/, ""),
    port: match.groups.port ? Number(match.groups.port) : match.groups.mode.toLowerCase() === "zk" ? 2181 : 31010,
    username: decodeUrlPart(props.get("user") || ""),
    password: decodeUrlPart(props.get("password") || ""),
    database: decodeUrlPart(props.get("schema") || "") || undefined,
    urlParams: urlParams.join(";"),
    ssl: false,
    connectionString: source,
  };
}

function parseJdbcDremioArrowFlightSqlUrl(source: string): ParsedConnectionUrl | null {
  if (!/^jdbc:arrow-flight-sql:\/\//i.test(source)) return null;

  let parsed: URL;
  try {
    parsed = new URL(source.replace(/^jdbc:/i, ""));
  } catch {
    return null;
  }

  const urlParams = parsed.search.replace(/^\?/, "");

  return {
    dbType: "jdbc",
    driverProfile: "dremio",
    driverLabel: "Dremio",
    host: parsed.hostname.replace(/^\[(.*)]$/, "$1"),
    port: parsed.port ? Number(parsed.port) : 32010,
    username: decodeUrlPart(parsed.username),
    password: decodeUrlPart(parsed.password),
    database: queryParamValue(urlParams, "schema") || undefined,
    urlParams,
    ssl: queryParamValue(urlParams, "useEncryption")?.toLowerCase() !== "false",
    connectionString: source,
  };
}

export function parseConnectionUrl(value: string, preferredProfile?: string): ParsedConnectionUrl {
  const input = value.trim();
  if (!input) {
    throw new Error("Connection URL is empty");
  }
  const jdbcH2 = parseH2JdbcUrl(input);
  if (jdbcH2) return jdbcH2;
  const jdbcUCanAccess = parseJdbcUCanAccessUrl(input);
  if (jdbcUCanAccess) return jdbcUCanAccess;
  const jdbcGbase8s = parseJdbcGbase8sUrl(input);
  if (jdbcGbase8s) return jdbcGbase8s;
  const jdbcInformix = parseJdbcInformixUrl(input);
  if (jdbcInformix) return jdbcInformix;
  const jdbcDremioArrowFlightSql = parseJdbcDremioArrowFlightSqlUrl(input);
  if (jdbcDremioArrowFlightSql) return jdbcDremioArrowFlightSql;
  const jdbcDremio = parseJdbcDremioUrl(input);
  if (jdbcDremio) return jdbcDremio;
  const jdbcOracle = parseJdbcOracleUrl(input);
  if (jdbcOracle) return jdbcOracle;
  const jdbcSqlServer = parseJdbcSqlServerUrl(input);
  if (jdbcSqlServer) return jdbcSqlServer;
  const isJdbcUrl = /^jdbc:/i.test(input);
  const source = isJdbcUrl ? input.replace(/^jdbc:/i, "") : input;

  const mongoResult = parseMongoUrl(source);
  if (mongoResult) return mongoResult;

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("Invalid connection URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const profile = connectionProfileForScheme(scheme, preferredProfile);
  if (!profile) {
    throw new Error(`Unsupported connection URL scheme: ${scheme}`);
  }

  const urlParams = parsed.search.replace(/^\?/, "");
  const name = connectionNameParam(parsed);
  const urlParamsWithoutName = stripConnectionNameParam(urlParams);
  const normalizedFragment = decodeUrlPart(parsed.hash.replace(/^#/, "")).trim().toLowerCase();
  const parsedUrlParams = profile.type === "redis" && normalizedFragment === "insecure" ? [urlParamsWithoutName, "insecure=true"].filter(Boolean).join("&") : urlParamsWithoutName;
  const mysqlCredentials = isJdbcUrl && profile.type === "mysql" ? extractMysqlCredentialParams(parsedUrlParams) : undefined;
  const effectiveUrlParams = mysqlCredentials?.urlParams ?? parsedUrlParams;
  if (profile.type === "mongodb") {
    return {
      dbType: profile.type,
      driverProfile: profile.profile,
      driverLabel: profile.label,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : profile.defaultPort,
      username: decodeUrlPart(parsed.username),
      password: decodeUrlPart(parsed.password),
      database: databaseFromPath(parsed.pathname),
      urlParams: parsedUrlParams,
      ssl: scheme === "mongodb+srv",
      connectionString: normalizeMongoConnectionString(source),
      useMongoUrl: true,
    };
  }
  if (profile.type === "zookeeper") {
    return {
      ...(name ? { name } : {}),
      dbType: profile.type,
      driverProfile: profile.profile,
      driverLabel: profile.label,
      host: parsed.hostname.replace(/^\[(.*)]$/, "$1"),
      port: parsed.port ? Number(parsed.port) : profile.defaultPort,
      username: decodeUrlPart(parsed.username),
      password: decodeUrlPart(parsed.password),
      database: undefined,
      urlParams: urlParamsWithoutName,
      ssl: false,
      connectionString: zookeeperConnectStringFromUrl(parsed, profile.defaultPort),
    };
  }

  return {
    ...(name ? { name } : {}),
    dbType: profile.type,
    driverProfile: profile.profile,
    driverLabel: profile.label,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : profile.defaultPort,
    ...(profile.type === "sqlserver" && parsed.port ? { portExplicit: true } : {}),
    username: mysqlCredentials?.username ?? decodeUrlPart(parsed.username),
    password: mysqlCredentials?.password ?? decodeUrlPart(parsed.password),
    database: databaseFromPath(parsed.pathname),
    urlParams: effectiveUrlParams,
    ssl: scheme === "rediss" || scheme === "https" || urlParamsRequireTls(profile.type, effectiveUrlParams) || (profile.type === "mysql" && isTidbCloudHost(parsed.hostname)),
  };
}

function zookeeperConnectStringFromUrl(parsed: URL, defaultPort: number): string {
  const rawHost = parsed.hostname.replace(/^\[(.*)]$/, "$1");
  const host = rawHost.includes(":") ? `[${rawHost}]` : rawHost;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  const chroot = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  return `${host}:${port}${chroot}`;
}

function applyParsedUsername(config: Omit<ConnectionConfig, "id">, parsed: ParsedConnectionUrl): string {
  if (parsed.dbType === "h2" && config.db_type === "h2" && !h2JdbcUrlHasUserParam(parsed.connectionString)) {
    return config.username || parsed.username;
  }
  return parsed.username;
}

function applyParsedPassword(config: Omit<ConnectionConfig, "id">, parsed: ParsedConnectionUrl): string {
  if (parsed.dbType === "h2" && config.db_type === "h2" && !h2JdbcUrlHasPasswordParam(parsed.connectionString)) {
    return config.password || parsed.password;
  }
  return parsed.password;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sqlServerExternalConfig(existing: unknown, parsed: ParsedConnectionUrl): unknown {
  if (parsed.dbType !== "sqlserver") return existing;

  const next = isRecord(existing) ? { ...existing } : {};
  delete next.port_explicit;
  if (parsed.portExplicit) {
    next.portExplicit = true;
  } else {
    delete next.portExplicit;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function applyParsedConnectionUrl(config: Omit<ConnectionConfig, "id">, parsed: ParsedConnectionUrl): Omit<ConnectionConfig, "id"> {
  return {
    ...config,
    db_type: parsed.dbType,
    driver_profile: parsed.driverProfile,
    driver_label: parsed.driverLabel,
    host: parsed.host,
    port: parsed.port,
    name: parsed.name?.trim() || config.name,
    username: applyParsedUsername(config, parsed),
    password: applyParsedPassword(config, parsed),
    database: parsed.database,
    url_params: parsed.urlParams,
    ssl: parsed.ssl,
    connection_string: parsed.connectionString,
    oracle_connection_type: parsed.oracleConnectionType,
    external_config: sqlServerExternalConfig(config.external_config, parsed),
  };
}
