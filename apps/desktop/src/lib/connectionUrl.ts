import type { ConnectionConfig, DatabaseType } from "@/types/database";

export interface ParsedConnectionUrl {
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
  mongodb: { type: "mongodb", profile: "mongodb", label: "MongoDB", defaultPort: 27017 },
  "mongodb+srv": { type: "mongodb", profile: "mongodb", label: "MongoDB", defaultPort: 27017 },
  clickhouse: { type: "clickhouse", profile: "clickhouse", label: "ClickHouse", defaultPort: 8123 },
  sqlserver: { type: "sqlserver", profile: "sqlserver", label: "SQL Server", defaultPort: 1433 },
  mssql: { type: "sqlserver", profile: "sqlserver", label: "SQL Server", defaultPort: 1433 },
  oracle: { type: "oracle", profile: "oracle", label: "Oracle", defaultPort: 1521 },
  elasticsearch: { type: "elasticsearch", profile: "elasticsearch", label: "Elasticsearch", defaultPort: 9200 },
  dm: { type: "dameng", profile: "dm", label: "DM (Dameng)", defaultPort: 5236 },
  dameng: { type: "dameng", profile: "dm", label: "DM (Dameng)", defaultPort: 5236 },
  gaussdb: { type: "gaussdb", profile: "gaussdb", label: "GaussDB", defaultPort: 5432 },
  kwdb: { type: "kwdb", profile: "kwdb", label: "KWDB", defaultPort: 26257 },
  gbase: { type: "gbase", profile: "gbase", label: "GBase", defaultPort: 5258 },
  "gbasedbt-sqli": { type: "gbase", profile: "gbase8s", label: "GBase 8s", defaultPort: 9088 },
  "informix-sqli": { type: "informix", profile: "informix", label: "Informix", defaultPort: 9088 },
  yashandb: { type: "yashandb", profile: "yashandb", label: "YashanDB", defaultPort: 1688 },
  opengauss: { type: "gaussdb", profile: "opengauss", label: "openGauss", defaultPort: 5432 },
  tdengine: { type: "tdengine", profile: "tdengine", label: "TDengine", defaultPort: 6041 },
  "taos-ws": { type: "tdengine", profile: "tdengine", label: "TDengine", defaultPort: 6041 },
  xugu: { type: "xugu", profile: "xugu", label: "XuguDB", defaultPort: 5138 },
  iotdb: { type: "iotdb", profile: "iotdb", label: "Apache IoTDB", defaultPort: 6667 },
  iris: { type: "iris", profile: "iris", label: "IRIS", defaultPort: 1972 },
};

const HTTP_SELECTED_PROFILES: Record<string, ConnectionProfile> = {
  clickhouse: SCHEME_PROFILES.clickhouse,
  elasticsearch: SCHEME_PROFILES.elasticsearch,
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

export function parseConnectionUrl(value: string, preferredProfile?: string): ParsedConnectionUrl {
  const input = value.trim();
  if (!input) {
    throw new Error("Connection URL is empty");
  }
  const jdbcUCanAccess = parseJdbcUCanAccessUrl(input);
  if (jdbcUCanAccess) return jdbcUCanAccess;
  const jdbcGbase8s = parseJdbcGbase8sUrl(input);
  if (jdbcGbase8s) return jdbcGbase8s;
  const jdbcInformix = parseJdbcInformixUrl(input);
  if (jdbcInformix) return jdbcInformix;
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
  const normalizedFragment = decodeUrlPart(parsed.hash.replace(/^#/, "")).trim().toLowerCase();
  const parsedUrlParams = profile.type === "redis" && normalizedFragment === "insecure" ? [urlParams, "insecure=true"].filter(Boolean).join("&") : urlParams;
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

  return {
    dbType: profile.type,
    driverProfile: profile.profile,
    driverLabel: profile.label,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : profile.defaultPort,
    username: mysqlCredentials?.username ?? decodeUrlPart(parsed.username),
    password: mysqlCredentials?.password ?? decodeUrlPart(parsed.password),
    database: databaseFromPath(parsed.pathname),
    urlParams: effectiveUrlParams,
    ssl: scheme === "rediss" || scheme === "https" || urlParamsRequireTls(profile.type, effectiveUrlParams) || (profile.type === "mysql" && isTidbCloudHost(parsed.hostname)),
  };
}

export function applyParsedConnectionUrl(config: Omit<ConnectionConfig, "id">, parsed: ParsedConnectionUrl): Omit<ConnectionConfig, "id"> {
  return {
    ...config,
    db_type: parsed.dbType,
    driver_profile: parsed.driverProfile,
    driver_label: parsed.driverLabel,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database,
    url_params: parsed.urlParams,
    ssl: parsed.ssl,
    connection_string: parsed.connectionString,
    oracle_connection_type: parsed.oracleConnectionType,
  };
}
