import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { GAUSSDB_M_JDBC_DRIVER_PROFILE } from "@/lib/database/jdbcDialect";

/**
 * Builds copy-ready connection strings (standard URL / JDBC URL / libpq DSN /
 * psql command) from a stored connection config. This is the inverse of
 * `parseConnectionUrl()` in `connectionUrl.ts`: only formats that are actually
 * usable in application code are produced, and unknown dialects are hidden
 * from the menu instead of guessing a wrong URL.
 *
 * Password safety: the primary formats (`url`, `jdbcUrl`, `dsn`) never embed
 * the stored password. Formats that do (`urlWithPassword`,
 * `jdbcUrlWithCredentials`, `dsnWithPassword`) are only offered when a
 * password is actually available, and the caller gates them behind an
 * explicit confirmation.
 */

export type ConnectionUrlCopyFormat = "url" | "urlWithPassword" | "jdbcUrl" | "jdbcUrlWithCredentials" | "hostPort" | "dsn" | "dsnWithPassword" | "psqlCommand";

/** Formats whose output embeds the stored password; callers should confirm before copying. */
export const CONNECTION_URL_COPY_WITH_PASSWORD_FORMATS: ReadonlySet<ConnectionUrlCopyFormat> = new Set(["urlWithPassword", "jdbcUrlWithCredentials", "dsnWithPassword"]);

export type ConnectionUrlCopyConfig = Pick<ConnectionConfig, "db_type" | "host" | "port" | "username" | "password" | "database" | "url_params" | "ssl" | "connection_string"> & Partial<Pick<ConnectionConfig, "driver_profile" | "oracle_connection_type">>;

export interface ConnectionUrlCopyOptions {
  /** Overrides `config.database` (e.g. the database tree node that was right-clicked). */
  database?: string;
}

/**
 * Types whose config shape does not map to a `scheme://user@host:port/db` URL
 * (cloud resource paths, service registries, message queues, file paths).
 */
const URL_COPY_UNSUPPORTED_DB_TYPES = new Set<DatabaseType>(["bigquery", "spanner", "cloudflare-d1", "turso", "nacos", "mq", "mqtt", "hbase"]);

/**
 * Standard (non-JDBC) URL schemes keyed by db_type. Values intentionally match
 * what real client libraries accept, not necessarily DBX's own display scheme.
 */
const STANDARD_URL_SCHEMES: Partial<Record<DatabaseType, string>> = {
  mysql: "mysql",
  doris: "mysql",
  starrocks: "mysql",
  manticoresearch: "mysql",
  goldendb: "mysql",
  postgres: "postgresql",
  redshift: "postgresql",
  questdb: "postgresql",
  kwdb: "postgresql",
  yashandb: "postgresql",
  highgo: "postgresql",
  uxdb: "postgresql",
  vastbase: "postgresql",
  sundb: "postgresql",
  gaussdb: "postgresql",
  kingbase: "kingbase8",
  sqlserver: "mssql",
  oracle: "oracle",
  clickhouse: "clickhouse",
  mongodb: "mongodb",
  redis: "redis",
  dameng: "dm",
  cassandra: "cassandra",
  neo4j: "bolt",
  etcd: "etcd",
  zookeeper: "zookeeper",
  oscar: "oscar",
  xugu: "xugu",
  iotdb: "iotdb",
  iris: "iris",
  trino: "trino",
  databend: "databend",
};

/** Schemes that are plain HTTP(S) endpoints. */
const HTTP_URL_DB_TYPES = new Set<DatabaseType>(["elasticsearch", "easysearch", "meilisearch", "qdrant", "milvus", "weaviate", "chromadb", "rqlite", "consul", "victoriametrics", "influxdb", "influxdb3", "dynamodb"]);

/**
 * Generic `prefix://host:port/db` JDBC dialects. Dialects with a different URL
 * shape (sqlserver, oracle, ...) are handled in `buildSpecialJdbcUrl()`.
 */
const JDBC_URL_PREFIXES: Partial<Record<DatabaseType, string>> = {
  mysql: "jdbc:mysql",
  doris: "jdbc:mysql",
  starrocks: "jdbc:mysql",
  manticoresearch: "jdbc:mysql",
  goldendb: "jdbc:mysql",
  postgres: "jdbc:postgresql",
  redshift: "jdbc:redshift",
  questdb: "jdbc:postgresql",
  gaussdb: "jdbc:postgresql",
  opengauss: "jdbc:opengauss",
  kingbase: "jdbc:kingbase8",
  highgo: "jdbc:highgo",
  clickhouse: "jdbc:clickhouse",
  dameng: "jdbc:dm",
  hive: "jdbc:hive2",
  kyuubi: "jdbc:hive2",
  argo: "jdbc:hive2",
  impala: "jdbc:impala",
  trino: "jdbc:trino",
  prestosql: "jdbc:presto",
  db2: "jdbc:db2",
  vertica: "jdbc:vertica",
  firebird: "jdbc:firebirdsql",
  databend: "jdbc:databend",
  cassandra: "jdbc:cassandra",
  neo4j: "jdbc:neo4j:bolt",
  ignite: "jdbc:ignite:thin",
  ignite3: "jdbc:ignite:thin",
  iotdb: "jdbc:iotdb",
  iris: "jdbc:IRIS",
  oscar: "jdbc:oscar",
  xugu: "jdbc:xugu",
};

/** PostgreSQL wire-protocol families that accept libpq DSN and psql. */
const POSTGRES_WIRE_DB_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "questdb", "kwdb", "yashandb", "kingbase", "highgo", "uxdb", "vastbase", "sundb"]);

/** PG-wire families whose JDBC driver accepts the `ssl`/`sslmode` properties. */
const PG_JDBC_PREFIXES = new Set(["jdbc:postgresql", "jdbc:redshift", "jdbc:gaussdb", "jdbc:opengauss", "jdbc:kingbase8", "jdbc:highgo"]);

function normalizedDriverProfile(config: ConnectionUrlCopyConfig): string {
  return config.driver_profile?.trim().toLowerCase() ?? "";
}

function isLocalFileUrlCopyConnection(config: ConnectionUrlCopyConfig): boolean {
  const dbType = config.db_type;
  return dbType === "sqlite" || dbType === "duckdb" || dbType === "access" || (dbType === "h2" && Number(config.port) === 0);
}

function explicitConnectionString(config: ConnectionUrlCopyConfig): string {
  return config.connection_string?.trim() ?? "";
}

function looksLikeConnectionString(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

export function connectionSupportsUrlCopy(config: ConnectionUrlCopyConfig | undefined): boolean {
  if (!config) return false;
  if (isLocalFileUrlCopyConnection(config)) return false;
  if (URL_COPY_UNSUPPORTED_DB_TYPES.has(config.db_type)) return false;
  return !!explicitConnectionString(config) || !!config.host?.trim();
}

function effectiveDatabase(config: ConnectionUrlCopyConfig, options?: ConnectionUrlCopyOptions): string {
  return options?.database?.trim() || config.database?.trim() || "";
}

function queryHasParam(params: string, keys: string[]): boolean {
  if (!params) return false;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return params
    .split(/[&;]/)
    .map((part) => part.split("=")[0]?.trim().toLowerCase())
    .some((key) => !!key && wanted.has(key));
}

function joinNonEmpty(separator: string, parts: (string | false | undefined | null)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(separator);
}

/** Brackets bare IPv6 literals; passes multi-host lists and full URLs through. */
function formatHostForUrl(host: string): string {
  if (host.includes("://") || host.includes(",") || host.startsWith("[")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

function shouldAppendPort(config: ConnectionUrlCopyConfig): boolean {
  const host = config.host?.trim() ?? "";
  return Number(config.port) > 0 && !host.includes(",") && !host.includes("://");
}

function buildUserInfo(config: ConnectionUrlCopyConfig, includePassword: boolean): string {
  const user = config.username?.trim() ?? "";
  const password = config.password ?? "";
  if (includePassword) {
    if (user && password) return `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
    if (user) return `${encodeURIComponent(user)}@`;
    if (password) return `:${encodeURIComponent(password)}@`;
    return "";
  }
  return user ? `${encodeURIComponent(user)}@` : "";
}

/** Mirrors the sidebar tooltip redaction so shared strings never leak secrets. */
function redactConnectionStringSecrets(value: string): string {
  return value.replace(/(:\/\/[^/\s:@?#;]+):([^@\s/?#;]+)@/g, "$1:***@").replace(/([?&;](?:password|pwd|pass|token|secret|key)=)[^&;]*/gi, "$1***");
}

function standardUrlScheme(config: ConnectionUrlCopyConfig): string | null {
  const profile = normalizedDriverProfile(config);
  switch (config.db_type) {
    case "mysql":
      if (profile === "oceanbase") return "oceanbase";
      if (profile === "mariadb") return "mariadb";
      return "mysql";
    case "redis":
      return config.ssl ? "rediss" : "redis";
    case "gaussdb":
      return profile === GAUSSDB_M_JDBC_DRIVER_PROFILE ? "jdbc:gaussdb" : "postgresql";
    case "iris":
      return profile === "cache" ? "cache" : "iris";
    default: {
      if (HTTP_URL_DB_TYPES.has(config.db_type)) return config.db_type === "dynamodb" ? "https" : config.ssl ? "https" : "http";
      return STANDARD_URL_SCHEMES[config.db_type] ?? null;
    }
  }
}

function standardUrlQuery(config: ConnectionUrlCopyConfig, scheme: string): string {
  const raw = (config.url_params ?? "").trim().replace(/^[?&]+/, "");
  const extras: string[] = [];
  if (config.ssl) {
    if ((scheme === "postgresql" || scheme === "kingbase8" || scheme === "jdbc:gaussdb") && !queryHasParam(raw, ["sslmode", "ssl"])) {
      extras.push("sslmode=require");
    } else if (scheme === "mysql" && !queryHasParam(raw, ["ssl-mode", "sslmode", "require_ssl", "usessl"])) {
      extras.push("ssl-mode=REQUIRED");
    } else if (scheme === "mongodb" && !queryHasParam(raw, ["tls", "ssl"])) {
      extras.push("tls=true");
    } else if (scheme === "clickhouse" && !queryHasParam(raw, ["secure", "ssl"])) {
      extras.push("secure=1");
    } else if (scheme === "cassandra" && !queryHasParam(raw, ["ssl"])) {
      extras.push("ssl=true");
    }
  }
  return joinNonEmpty("&", [raw, ...extras]);
}

function buildStandardUrl(config: ConnectionUrlCopyConfig, options: ConnectionUrlCopyOptions & { includePassword: boolean }): string | null {
  const explicit = explicitConnectionString(config);
  const scheme = standardUrlScheme(config);
  if (explicit && (!scheme || looksLikeConnectionString(explicit))) {
    return options.includePassword ? explicit : redactConnectionStringSecrets(explicit);
  }
  if (!scheme) return null;
  const host = config.host?.trim() ?? "";
  if (!host) return null;

  const database = effectiveDatabase(config, options);
  const userInfo = buildUserInfo(config, options.includePassword);
  const hostPart = formatHostForUrl(host);
  const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
  const path = database ? `/${encodeURIComponent(database)}` : "";
  const query = standardUrlQuery(config, scheme);
  return `${scheme}://${userInfo}${hostPart}${portPart}${path}${query ? `?${query}` : ""}`;
}

function jdbcPrefixFor(config: ConnectionUrlCopyConfig): string | null {
  const profile = normalizedDriverProfile(config);
  switch (config.db_type) {
    case "mysql":
      if (profile === "oceanbase") return "jdbc:oceanbase";
      if (profile === "mariadb") return "jdbc:mariadb";
      return "jdbc:mysql";
    case "gaussdb":
      return profile === GAUSSDB_M_JDBC_DRIVER_PROFILE ? "jdbc:gaussdb" : "jdbc:postgresql";
    case "iris":
      return profile === "cache" ? "jdbc:Cache" : "jdbc:IRIS";
    case "gbase":
      return profile === "gbase8s" ? "jdbc:gbasedbt-sqli" : null;
    case "tdengine":
      return Number(config.port) === 6030 ? "jdbc:TAOS" : "jdbc:TAOS-RS";
    default:
      return JDBC_URL_PREFIXES[config.db_type] ?? null;
  }
}

function jdbcCredentialParams(config: ConnectionUrlCopyConfig, withCredentials: boolean): string[] {
  if (!withCredentials) return [];
  const params: string[] = [];
  const user = config.username?.trim() ?? "";
  if (user) params.push(`user=${encodeURIComponent(user)}`);
  if (config.password) params.push(`password=${encodeURIComponent(config.password)}`);
  return params;
}

/**
 * Dialects whose JDBC URL is not `prefix://host:port/db?query`.
 * Returns `undefined` when the type is not a special dialect, `null` when the
 * dialect is special but cannot be built from this config.
 */
function buildSpecialJdbcUrl(config: ConnectionUrlCopyConfig, database: string, withCredentials: boolean): string | null | undefined {
  const host = config.host?.trim() ?? "";
  const rawParams = (config.url_params ?? "").trim();
  const credentials = jdbcCredentialParams(config, withCredentials);

  switch (config.db_type) {
    case "sqlserver": {
      const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
      const props = joinNonEmpty(";", [database && `databaseName=${database}`, ...credentials, rawParams.replace(/^[?&]+/, "").replace(/&/g, ";"), config.ssl && !queryHasParam(rawParams, ["encrypt"]) && "encrypt=true"]);
      return `jdbc:sqlserver://${formatHostForUrl(host)}${portPart}${props ? `;${props}` : ""}`;
    }
    case "oracle": {
      const connectionType = config.oracle_connection_type ?? "service_name";
      if (connectionType === "tns") {
        const explicit = explicitConnectionString(config);
        return explicit ? explicit : null;
      }
      const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
      const query = joinNonEmpty("&", [...credentials, rawParams.replace(/^[?&]+/, "")]);
      if (connectionType === "sid") {
        return `jdbc:oracle:thin:@${formatHostForUrl(host)}${portPart}:${database}${query ? `?${query}` : ""}`;
      }
      return `jdbc:oracle:thin:@//${formatHostForUrl(host)}${portPart}/${database}${query ? `?${query}` : ""}`;
    }
    case "saphana": {
      const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
      const query = joinNonEmpty("&", [database && `databaseName=${database}`, ...credentials, rawParams.replace(/^[?&]+/, "")]);
      return `jdbc:sap://${formatHostForUrl(host)}${portPart}/${query ? `?${query}` : ""}`;
    }
    case "teradata": {
      const props = joinNonEmpty(",", [Number(config.port) > 0 && `DBS_PORT=${config.port}`, database && `DATABASE=${database}`, ...credentials, rawParams.replace(/^[?&]+/, "").replace(/[;&]/g, ",")]);
      return `jdbc:teradata://${formatHostForUrl(host)}${props ? `/${props}` : ""}`;
    }
    case "exasol": {
      const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
      const props = joinNonEmpty(";", [database && `schema=${database}`, ...credentials, rawParams.replace(/^[?&]+/, "").replace(/&/g, ";")]);
      return `jdbc:exa:${formatHostForUrl(host)}${portPart}${props ? `;${props}` : ""}`;
    }
    case "snowflake": {
      if (!host) return null;
      const query = joinNonEmpty("&", [database && `db=${database}`, ...credentials, rawParams.replace(/^[?&]+/, "")]);
      return `jdbc:snowflake://${formatHostForUrl(host)}/${query ? `?${query}` : ""}`;
    }
    case "informix":
    case "gbase": {
      const prefix = config.db_type === "informix" ? "jdbc:informix-sqli" : jdbcPrefixFor(config);
      if (!prefix) return config.db_type === "gbase" ? null : undefined;
      const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
      // Informix-style URLs append properties after a second colon: /db:INFORMIXSERVER=x;user=y
      const props = joinNonEmpty(";", [rawParams.replace(/^[?:&]+/, ""), ...credentials.map((param) => decodeURIComponent(param))]);
      return `${prefix}://${formatHostForUrl(host)}${portPart}/${database}${props ? `:${props}` : ""}`;
    }
    default:
      return undefined;
  }
}

function jdbcQuery(config: ConnectionUrlCopyConfig, prefix: string, withCredentials: boolean): string {
  const raw = (config.url_params ?? "").trim().replace(/^[?&]+/, "");
  const parts = [...jdbcCredentialParams(config, withCredentials)];
  if (raw) parts.push(raw);
  if (config.ssl) {
    if (PG_JDBC_PREFIXES.has(prefix) && !queryHasParam(raw, ["ssl", "sslmode"])) {
      parts.push("ssl=true");
    } else if ((prefix === "jdbc:mysql" || prefix === "jdbc:mariadb" || prefix === "jdbc:oceanbase") && !queryHasParam(raw, ["usessl", "sslmode", "requiressl"])) {
      parts.push("sslMode=REQUIRED");
    } else if (prefix === "jdbc:clickhouse" && !queryHasParam(raw, ["ssl", "sslmode", "secure"])) {
      parts.push("ssl=true");
    }
  }
  return joinNonEmpty("&", parts);
}

function buildJdbcUrl(config: ConnectionUrlCopyConfig, options: ConnectionUrlCopyOptions & { withCredentials: boolean }): string | null {
  const explicit = explicitConnectionString(config);
  if (explicit && /^jdbc:/i.test(explicit)) return options.withCredentials ? explicit : redactConnectionStringSecrets(explicit);
  const host = config.host?.trim() ?? "";
  if (!host) return null;

  const database = effectiveDatabase(config, options);
  const special = buildSpecialJdbcUrl(config, database, options.withCredentials);
  if (special !== undefined) return special;

  const prefix = jdbcPrefixFor(config);
  if (!prefix) return null;
  const portPart = shouldAppendPort(config) ? `:${config.port}` : "";
  const path = database ? `/${encodeURIComponent(database)}` : "";
  const query = jdbcQuery(config, prefix, options.withCredentials);
  return `${prefix}://${formatHostForUrl(host)}${portPart}${path}${query ? `?${query}` : ""}`;
}

function buildHostPort(config: ConnectionUrlCopyConfig): string | null {
  const host = config.host?.trim() ?? "";
  if (!host) return null;
  if (host.includes(",") || host.includes("://")) return host;
  const hostPart = formatHostForUrl(host);
  return Number(config.port) > 0 ? `${hostPart}:${config.port}` : hostPart;
}

function quoteDsnValue(value: string): string {
  if (!/[\s'\\]/.test(value)) return value;
  return `'${value.replace(/(['\\])/g, "\\$1")}'`;
}

function isPostgresWireFamily(config: ConnectionUrlCopyConfig): boolean {
  if (!POSTGRES_WIRE_DB_TYPES.has(config.db_type)) return false;
  if (config.db_type === "gaussdb" && normalizedDriverProfile(config) === GAUSSDB_M_JDBC_DRIVER_PROFILE) return false;
  const explicit = explicitConnectionString(config);
  return !(explicit && /^jdbc:/i.test(explicit));
}

/** libpq-style `host=... port=... user=... [password=...] dbname=...` DSN. */
function buildKeyvalueDsn(config: ConnectionUrlCopyConfig, options: ConnectionUrlCopyOptions & { includePassword: boolean }): string | null {
  const host = config.host?.trim() ?? "";
  if (!host) return null;
  const parts = [`host=${quoteDsnValue(host)}`];
  if (shouldAppendPort(config)) parts.push(`port=${config.port}`);
  const user = config.username?.trim() ?? "";
  if (user) parts.push(`user=${quoteDsnValue(user)}`);
  if (options.includePassword && config.password) parts.push(`password=${quoteDsnValue(config.password)}`);
  const database = effectiveDatabase(config, options);
  if (database) parts.push(`dbname=${quoteDsnValue(database)}`);
  const raw = (config.url_params ?? "").trim().replace(/^[?&]+/, "");
  for (const param of raw.split("&")) {
    const [key, ...rest] = param.split("=");
    if (!key.trim()) continue;
    parts.push(`${key.trim()}=${quoteDsnValue(decodeURIComponent(rest.join("=")))}`);
  }
  if (config.ssl && !queryHasParam(raw, ["sslmode"])) parts.push("sslmode=require");
  return parts.join(" ");
}

function buildPsqlCommand(config: ConnectionUrlCopyConfig, options: ConnectionUrlCopyOptions): string | null {
  const host = config.host?.trim() ?? "";
  if (!host) return null;
  const args = ["psql", "-h", host];
  if (shouldAppendPort(config)) args.push("-p", String(config.port));
  const user = config.username?.trim() ?? "";
  if (user) args.push("-U", user);
  const database = effectiveDatabase(config, options);
  if (database) args.push("-d", database);
  return args.join(" ");
}

/**
 * Whether a password-inclusive copy would actually carry a secret: either a
 * stored password or an explicit connection string with embedded credentials.
 */
function hasCopyableSecret(config: ConnectionUrlCopyConfig): boolean {
  if (config.password) return true;
  const explicit = explicitConnectionString(config);
  return !!explicit && redactConnectionStringSecrets(explicit) !== explicit;
}

/**
 * Lists the copy formats available for a connection, deduplicating entries
 * that would produce identical text (e.g. no stored password, or an explicit
 * connection string that already is the JDBC URL). Password-inclusive formats
 * are only offered when a secret is actually available, so the plain items
 * are always safe to paste.
 */
export function connectionUrlCopyFormats(config: ConnectionUrlCopyConfig | undefined): ConnectionUrlCopyFormat[] {
  if (!connectionSupportsUrlCopy(config)) return [];
  const candidate = config as ConnectionUrlCopyConfig;
  const formats: ConnectionUrlCopyFormat[] = [];
  const hasSecret = hasCopyableSecret(candidate);
  const url = buildStandardUrl(candidate, { includePassword: false });
  const urlWithPassword = buildStandardUrl(candidate, { includePassword: true });
  if (url) formats.push("url");
  if (urlWithPassword && hasSecret && urlWithPassword !== url) formats.push("urlWithPassword");
  const jdbcUrl = buildJdbcUrl(candidate, { withCredentials: false });
  const jdbcUrlWithCredentials = buildJdbcUrl(candidate, { withCredentials: true });
  if (jdbcUrl && jdbcUrl !== url) formats.push("jdbcUrl");
  // Without a secret the "with credentials" URL would only add `user=` (or
  // nothing), which is misleading next to its label — hide it in that case.
  if (jdbcUrlWithCredentials && hasSecret && jdbcUrlWithCredentials !== jdbcUrl && jdbcUrlWithCredentials !== urlWithPassword && jdbcUrlWithCredentials !== url) formats.push("jdbcUrlWithCredentials");
  if (buildHostPort(candidate)) formats.push("hostPort");
  if (isPostgresWireFamily(candidate)) {
    const dsn = buildKeyvalueDsn(candidate, { includePassword: false });
    const dsnWithPassword = buildKeyvalueDsn(candidate, { includePassword: true });
    if (dsn) formats.push("dsn");
    if (dsnWithPassword && hasSecret && dsnWithPassword !== dsn) formats.push("dsnWithPassword");
    if (buildPsqlCommand(candidate, {})) formats.push("psqlCommand");
  }
  return formats;
}

export function buildConnectionUrlCopy(config: ConnectionUrlCopyConfig | undefined, format: ConnectionUrlCopyFormat, options?: ConnectionUrlCopyOptions): string | null {
  if (!connectionSupportsUrlCopy(config)) return null;
  const candidate = config as ConnectionUrlCopyConfig;
  switch (format) {
    case "url":
      return buildStandardUrl(candidate, { ...options, includePassword: false });
    case "urlWithPassword":
      return buildStandardUrl(candidate, { ...options, includePassword: true });
    case "jdbcUrl":
      return buildJdbcUrl(candidate, { ...options, withCredentials: false });
    case "jdbcUrlWithCredentials":
      return buildJdbcUrl(candidate, { ...options, withCredentials: true });
    case "hostPort":
      return buildHostPort(candidate);
    case "dsn":
      return isPostgresWireFamily(candidate) ? buildKeyvalueDsn(candidate, { ...options, includePassword: false }) : null;
    case "dsnWithPassword":
      return isPostgresWireFamily(candidate) ? buildKeyvalueDsn(candidate, { ...options, includePassword: true }) : null;
    case "psqlCommand":
      return isPostgresWireFamily(candidate) ? buildPsqlCommand(candidate, options ?? {}) : null;
    default:
      return null;
  }
}
