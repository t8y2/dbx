import type { ConnectionConfig, ProxyTunnelConfig } from "./connections.js";
import type { SslOptions } from "mysql2";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sqlSafetyFromEnv } from "./sql-safety.js";
import { isDirectQueryType } from "./diagnostics.js";
import { bridgePortFilePath } from "./paths.js";
import { parseRedisCommandArgv, classifyRedisCommand, type RedisCommandOptions, type RedisCommandResult, type RedisCommandSafety } from "./redis-command.js";

export interface TableInfo {
  name: string;
  type: string;
}

export interface CollectionInfo {
  name: string;
  id?: string;
  dimension?: number | null;
}

type CollectionListEntry = string | CollectionInfo;

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  comment: string | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  character_maximum_length?: number | null;
  enum_values?: string[] | null;
  character_set?: string | null;
  collation?: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

export interface QueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

const MAX_ROWS = 100;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 30_000;

interface PoolEntry {
  type: "pg" | "mysql";
  pool: unknown;
  timer: ReturnType<typeof setTimeout>;
}

interface RqliteResult {
  columns?: string[];
  values?: unknown[][];
  rows_affected?: number;
  error?: string;
}

interface RqliteResponse {
  results?: RqliteResult[];
}

const pools = new Map<string, PoolEntry>();
const proxyTunnels = new Map<string, { server: Server; port: number; sockets: Set<Socket> }>();

function poolKey(config: ConnectionConfig): string {
  return `${config.id}:${config.database || ""}`;
}

function evictPool(key: string, entry: PoolEntry) {
  pools.delete(key);
  clearTimeout(entry.timer);
  if (entry.type === "pg") {
    (entry.pool as import("pg").Pool).end().catch(() => {});
  } else {
    (entry.pool as import("mysql2/promise").Pool).end().catch(() => {});
  }
}

function resetIdleTimer(key: string, entry: PoolEntry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => evictPool(key, entry), IDLE_TIMEOUT_MS);
}

export async function closeDatabaseResources(): Promise<void> {
  const poolEntries = [...pools.entries()];
  pools.clear();
  await Promise.all(
    poolEntries.map(async ([, entry]) => {
      clearTimeout(entry.timer);
      if (entry.type === "pg") {
        await (entry.pool as import("pg").Pool).end().catch(() => {});
      } else {
        await (entry.pool as import("mysql2/promise").Pool).end().catch(() => {});
      }
    }),
  );

  const tunnels = [...proxyTunnels.values()];
  proxyTunnels.clear();
  await Promise.all(
    tunnels.map(
      ({ server, sockets }) =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    ),
  );
}

async function getPgPool(config: ConnectionConfig): Promise<import("pg").Pool> {
  const key = poolKey(config);
  const existing = pools.get(key);
  if (existing?.type === "pg") {
    resetIdleTimer(key, existing);
    return existing.pool as import("pg").Pool;
  }

  const pg = await import("pg");
  const endpoint = await connectionEndpoint(config);
  const pool = new pg.default.Pool({
    connectionString: buildConnectionUrl(config, endpoint),
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", () => {});
  const entry: PoolEntry = { type: "pg", pool, timer: setTimeout(() => {}, 0) };
  pools.set(key, entry);
  resetIdleTimer(key, entry);
  return pool;
}

async function getMysqlPool(config: ConnectionConfig): Promise<import("mysql2/promise").Pool> {
  const key = poolKey(config);
  const existing = pools.get(key);
  if (existing?.type === "mysql") {
    resetIdleTimer(key, existing);
    return existing.pool as import("mysql2/promise").Pool;
  }

  const mysql = await import("mysql2/promise");
  const endpoint = await connectionEndpoint(config);
  const poolOptions: import("mysql2/promise").PoolOptions = {
    uri: buildConnectionUrl(config, endpoint),
    connectionLimit: 3,
    idleTimeout: 30_000,
    connectTimeout: 10_000,
  };
  const tls = await mysqlTlsOptions(config);
  if (tls) poolOptions.ssl = tls;
  const pool = mysql.default.createPool(poolOptions);
  const entry: PoolEntry = { type: "mysql", pool, timer: setTimeout(() => {}, 0) };
  pools.set(key, entry);
  resetIdleTimer(key, entry);
  return pool;
}

type ProxyLayer = { type: "proxy" } & ProxyTunnelConfig;

function hasActiveSshLayer(config: ConnectionConfig): boolean {
  return config.transport_layers?.some((layer) => layer.type === "ssh" && layer.enabled !== false && !!layer.host) ?? false;
}

function firstProxyLayer(config: ConnectionConfig): ProxyLayer | undefined {
  return config.transport_layers?.find((layer): layer is ProxyLayer => layer.type === "proxy" && layer.enabled !== false && !!layer.host);
}

function hasDirectRedisSupport(config: ConnectionConfig): boolean {
  const mode = config.redis_connection_mode || "standalone";
  return config.db_type === "redis" && mode === "standalone" && !hasActiveSshLayer(config);
}

async function connectionEndpoint(config: ConnectionConfig): Promise<{ host: string; port: number }> {
  const proxy = firstProxyLayer(config);
  if (!proxy) return { host: config.host, port: config.port };
  const existing = proxyTunnels.get(config.id);
  if (existing) return { host: "127.0.0.1", port: existing.port };

  const sockets = new Set<Socket>();
  const server = createServer((inbound) => {
    sockets.add(inbound);
    inbound.once("close", () => sockets.delete(inbound));
    connectViaProxy(config, proxy)
      .then((outbound) => {
        sockets.add(outbound);
        outbound.once("close", () => sockets.delete(outbound));
        inbound.pipe(outbound);
        outbound.pipe(inbound);
      })
      .catch(() => inbound.destroy());
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Failed to bind proxy tunnel"));
    });
  });
  proxyTunnels.set(config.id, { server, port, sockets });
  return { host: "127.0.0.1", port };
}

export function buildConnectionUrl(config: ConnectionConfig, endpoint: { host: string; port: number }): string {
  const db = config.database || "";
  if (isMysqlType(config.db_type)) {
    const params = buildMysqlUrlParams(config);
    const suffix = params ? `?${params}` : "";
    return `mysql://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${endpoint.host}:${endpoint.port}/${db}${suffix}`;
  }
  if (!isPostgresType(config.db_type)) {
    throw new Error(`Unsupported pooled connection type: ${config.db_type}`);
  }
  const params = normalizePostgresUrlParams(config.url_params || "", config.ssl);
  const suffix = params ? `?${params}` : "";
  return `postgres://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${endpoint.host}:${endpoint.port}/${db}${suffix}`;
}

function normalizePostgresUrlParams(value: string, forceTls: boolean): string {
  const parts: string[] = [];
  let timezone: string | undefined;
  let searchPath: string | undefined;
  for (const part of value.trim().replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [rawKey, rawValue] = splitUrlParam(part);
    const key = decodeUrlParamPart(rawKey);
    const lowerKey = key.toLowerCase();
    if (lowerKey === "timezone" || lowerKey === "time_zone") {
      const decoded = decodeUrlParamPart(rawValue).trim();
      if (decoded) timezone = decoded;
      continue;
    }
    if (lowerKey === "schema" || lowerKey === "currentschema") {
      const decoded = decodeUrlParamPart(rawValue).trim();
      if (decoded) searchPath = decoded;
      continue;
    }
    if (lowerKey === "ssl-mode") {
      const value = decodeUrlParamPart(rawValue).toLowerCase().replaceAll("_", "-");
      if (value === "require" || value === "required") parts.push("sslmode=require");
      else if (value === "prefer" || value === "preferred") parts.push("sslmode=prefer");
      else if (value === "disable" || value === "disabled") parts.push("sslmode=disable");
      else if (value === "verify-ca") parts.push("sslmode=verify-ca");
      else if (value === "verify-full" || value === "verify-identity") parts.push("sslmode=verify-full");
      continue;
    }
    if (lowerKey === "charset" || lowerKey === "require_ssl" || lowerKey === "verify_ca" || lowerKey === "verify_identity") {
      continue;
    }
    parts.push(part);
  }

  const connectionOptions: Array<{ needle: string; value: string }> = [];
  if (searchPath) connectionOptions.push({ needle: "search_path=", value: `-c search_path=${searchPath}` });
  if (timezone) connectionOptions.push({ needle: "timezone=", value: `-c TimeZone=${timezone}` });
  if (connectionOptions.length > 0) {
    const optionsIndex = parts.findIndex((part) => urlParamKeyIs(part, "options"));
    if (optionsIndex >= 0) {
      const [rawKey, rawValue] = splitUrlParam(parts[optionsIndex]);
      const optionsValue = decodeUrlParamPart(rawValue);
      const lowerOptions = optionsValue.toLowerCase();
      const appended = connectionOptions
        .filter((option) => !lowerOptions.includes(option.needle))
        .map((option) => option.value)
        .join(" ");
      if (appended) {
        const combined = `${optionsValue.trim()} ${appended}`.trim();
        parts[optionsIndex] = `${rawKey}=${encodeURIComponent(combined)}`;
      }
    } else {
      parts.push(`options=${encodeURIComponent(connectionOptions.map((option) => option.value).join(" "))}`);
    }
  }

  if (forceTls && !parts.some((part) => urlParamKeyIs(part, "sslmode"))) {
    parts.unshift("sslmode=require");
  }
  return parts.join("&");
}

function urlParamKeyIs(part: string, expected: string): boolean {
  const [rawKey] = splitUrlParam(part);
  return decodeUrlParamPart(rawKey).toLowerCase() === expected.toLowerCase();
}

function splitUrlParam(part: string): [string, string] {
  const index = part.indexOf("=");
  if (index < 0) return [part, ""];
  return [part.slice(0, index), part.slice(index + 1)];
}

function decodeUrlParamPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function urlParams(config: ConnectionConfig): URLSearchParams {
  return new URLSearchParams((config.url_params || "").trim().replace(/^\?/, ""));
}

function connectViaProxy(config: ConnectionConfig, proxy: ProxyLayer): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxy.port || 1080, proxy.host || "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      if ((proxy.proxy_type || "socks5") === "http") {
        httpConnect(socket, config, proxy, resolve, reject);
      } else {
        socks5Connect(socket, config, proxy, resolve, reject);
      }
    });
  });
}

function httpConnect(socket: Socket, config: ConnectionConfig, proxy: ProxyLayer, resolve: (socket: Socket) => void, reject: (err: Error) => void) {
  const target = `${config.host}:${config.port}`;
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (proxy.username || proxy.password) {
    const token = Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on("data", function onData(chunk: Buffer) {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    socket.off("data", onData);
    const head = buffer.subarray(0, end).toString("utf8");
    if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
      reject(new Error(`HTTP proxy CONNECT failed: ${head.split("\r\n")[0] || "invalid response"}`));
      socket.destroy();
      return;
    }
    const rest = buffer.subarray(end + 4);
    if (rest.length) socket.unshift(rest);
    resolve(socket);
  });
}

function socks5Connect(socket: Socket, config: ConnectionConfig, proxy: ProxyLayer, resolve: (socket: Socket) => void, reject: (err: Error) => void) {
  const wantsAuth = !!(proxy.username || proxy.password);
  socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  socket.once("data", (method) => {
    if (method.length < 2 || method[0] !== 0x05) {
      reject(new Error("Invalid SOCKS greeting"));
      socket.destroy();
      return;
    }
    if (method[1] === 0x02) {
      const user = Buffer.from(proxy.username || "");
      const pass = Buffer.from(proxy.password || "");
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      socket.once("data", (auth) => {
        if (auth.length < 2 || auth[1] !== 0x00) {
          reject(new Error("SOCKS proxy authentication failed"));
          socket.destroy();
          return;
        }
        sendSocksConnect(socket, config, resolve, reject);
      });
    } else if (method[1] === 0x00) {
      sendSocksConnect(socket, config, resolve, reject);
    } else {
      reject(new Error("SOCKS proxy rejected authentication methods"));
      socket.destroy();
    }
  });
}

function sendSocksConnect(socket: Socket, config: ConnectionConfig, resolve: (socket: Socket) => void, reject: (err: Error) => void) {
  const host = Buffer.from(config.host);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, portBytes(config.port)]));
  socket.once("data", (res) => {
    if (res.length < 4 || res[0] !== 0x05 || res[1] !== 0x00) {
      reject(new Error(`SOCKS proxy connect failed with code ${res[1] ?? "unknown"}`));
      socket.destroy();
      return;
    }
    resolve(socket);
  });
}

function portBytes(port: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(port);
  return buf;
}

function isMysqlType(dbType: string): boolean {
  return dbType === "mysql" || dbType === "doris" || dbType === "starrocks" || dbType === "manticoresearch";
}

function isStarrocksConnection(config: ConnectionConfig): boolean {
  return config.db_type === "starrocks" || config.driver_profile?.toLowerCase() === "starrocks";
}

function needsBareMysql(config: ConnectionConfig): boolean {
  const profile = config.driver_profile?.toLowerCase();
  return config.db_type === "doris" || config.db_type === "starrocks" || config.db_type === "manticoresearch" || profile === "doris" || profile === "starrocks" || profile === "manticoresearch" || profile === "selectdb" || profile === "oceanbase";
}

function mysqlTlsFileParamIs(key: string, target: "cert" | "key"): boolean {
  return key.toLowerCase().replace(/[-_]/g, "") === `ssl${target}`;
}

function mysqlUrlParamsRequireTls(params: string): boolean {
  for (const part of params.trim().replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [rawKey, rawValue = ""] = splitUrlParam(part);
    const key = decodeUrlParamPart(rawKey);
    const value = decodeUrlParamPart(rawValue);
    if (key.toLowerCase() === "require_ssl" && value.toLowerCase() === "true") return true;
    if (mysqlTlsFileParamIs(key, "cert") || mysqlTlsFileParamIs(key, "key")) return true;
    if (key.toLowerCase() === "ssl-mode" || key.toLowerCase() === "sslmode") {
      const mode = value.toLowerCase().replace(/-/g, "_");
      if (mode === "required" || mode === "require" || mode === "verify_ca" || mode === "verify_identity") return true;
    }
  }
  return false;
}

function mysqlUrlParamsTlsDisabled(params: string): boolean {
  for (const part of params.trim().replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [rawKey, rawValue = ""] = splitUrlParam(part);
    const key = decodeUrlParamPart(rawKey).toLowerCase();
    const value = decodeUrlParamPart(rawValue).toLowerCase();
    if (key === "require_ssl" && value === "false") return true;
    if ((key === "ssl-mode" || key === "sslmode") && (value === "disabled" || value === "disable")) return true;
  }
  return false;
}

function mysqlUsesTls(config: ConnectionConfig): boolean {
  return !!config.ssl || mysqlUrlParamsRequireTls(config.url_params || "");
}

function bareMysqlUsesTls(config: ConnectionConfig): boolean {
  if (!isStarrocksConnection(config)) {
    return false;
  }
  if (mysqlUrlParamsTlsDisabled(config.url_params || "")) {
    return false;
  }
  return mysqlUsesTls(config);
}

function normalizeBareMysqlUrlParams(value: string): string {
  return value
    .trim()
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => {
      if (!part) return false;
      const key = decodeUrlParamPart(splitUrlParam(part)[0]).toLowerCase();
      return key !== "charset" && key !== "ssl-mode" && key !== "sslmode" && key !== "require_ssl" && key !== "verify_ca" && key !== "verify_identity";
    })
    .join("&");
}

function normalizeMysqlUrlParams(value: string, forceTls: boolean, acceptInvalidCerts: boolean): string {
  const parts = value
    .trim()
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part.length > 0);

  if (forceTls) {
    const filtered = parts.filter((part) => {
      const key = decodeUrlParamPart(splitUrlParam(part)[0]).toLowerCase();
      return key !== "ssl-mode" && key !== "sslmode" && key !== "require_ssl";
    });
    filtered.unshift("require_ssl=true");
    if (acceptInvalidCerts && !filtered.some((part) => urlParamKeyIs(part, "verify_ca"))) {
      filtered.push("verify_ca=false");
    }
    if (!filtered.some((part) => urlParamKeyIs(part, "verify_identity"))) {
      filtered.push("verify_identity=false");
    }
    if (!filtered.some((part) => urlParamKeyIs(part, "charset"))) {
      filtered.push("charset=utf8mb4");
    }
    return filtered.join("&");
  }

  if (!parts.some((part) => urlParamKeyIs(part, "ssl-mode") || urlParamKeyIs(part, "sslmode") || urlParamKeyIs(part, "require_ssl"))) {
    parts.unshift("ssl-mode=disabled");
  }
  if (!parts.some((part) => urlParamKeyIs(part, "charset"))) {
    parts.push("charset=utf8mb4");
  }
  return parts.join("&");
}

function buildMysqlUrlParams(config: ConnectionConfig): string {
  const raw = config.url_params || "";
  if (needsBareMysql(config)) {
    if (bareMysqlUsesTls(config)) {
      return normalizeMysqlUrlParams(raw, true, !config.ca_cert_path?.trim());
    }
    return normalizeBareMysqlUrlParams(raw);
  }
  return raw;
}

async function mysqlTlsOptions(config: ConnectionConfig): Promise<SslOptions | undefined> {
  if (!bareMysqlUsesTls(config)) return undefined;

  const params = urlParams(config);
  const tls: SslOptions = {};
  const verifyCa = (params.get("verify_ca") || "").toLowerCase() === "true";
  const verifyIdentity = (params.get("verify_identity") || "").toLowerCase() === "true";
  if (!verifyCa && !verifyIdentity) {
    tls.rejectUnauthorized = false;
  }
  if (config.ca_cert_path) tls.ca = await readFile(config.ca_cert_path);
  const certPath = params.get("ssl-cert") || params.get("sslcert");
  const keyPath = params.get("ssl-key") || params.get("sslkey");
  if (certPath) tls.cert = await readFile(certPath);
  if (keyPath) tls.key = await readFile(keyPath);
  return tls;
}

function isPostgresType(dbType: string): boolean {
  return dbType === "postgres" || dbType === "redshift" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss" || dbType === "questdb";
}

interface BridgeQueryResult {
  columns: string[];
  rows: unknown[][];
  affected_rows: number;
  execution_time_ms: number;
  truncated: boolean;
}

interface BridgeTableInfo {
  name: string;
  table_type: string;
  comment: string | null;
}

interface BridgeColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  comment: string | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  character_maximum_length?: number | null;
  enum_values?: string[] | null;
  character_set?: string | null;
  collation?: string | null;
}

const POSTGRES_DESCRIBE_TABLE_SQL = `SELECT c.column_name AS name, CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS data_type, c.is_nullable = 'YES' AS is_nullable, c.column_default, CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_primary_key, col_description(cls.oid, c.ordinal_position) AS comment, CASE WHEN enum_t.oid IS NULL THEN NULL ELSE COALESCE((SELECT array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder)) FROM pg_enum e WHERE e.enumtypid = enum_t.oid), '[]'::json) END AS enum_values FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage kcu ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.constraint_type = 'PRIMARY KEY' LEFT JOIN pg_class cls ON cls.relname = c.table_name AND cls.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema) LEFT JOIN pg_namespace type_ns ON type_ns.nspname = c.udt_schema LEFT JOIN pg_type t ON t.typnamespace = type_ns.oid AND t.typname = c.udt_name LEFT JOIN pg_type enum_t ON enum_t.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype WHEN t.typtype = 'e' THEN t.oid ELSE NULL END AND enum_t.typtype = 'e' WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`;
const POSTGRES_DESCRIBE_TABLE_COMPAT_SQL = `SELECT c.column_name AS name, CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS data_type, c.is_nullable = 'YES' AS is_nullable, c.column_default, CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_primary_key, col_description(cls.oid, c.ordinal_position) AS comment, NULL AS enum_values FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage kcu ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.constraint_type = 'PRIMARY KEY' LEFT JOIN pg_class cls ON cls.relname = c.table_name AND cls.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema) WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`;
const MYSQL_DESCRIBE_TABLE_SQL = `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS data_type, c.COLUMN_TYPE AS column_type, c.IS_NULLABLE = 'YES' AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY = 'PRI' AS is_primary_key, c.COLUMN_COMMENT AS comment, c.CHARACTER_SET_NAME AS character_set, c.COLLATION_NAME AS collation FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION`;

function normalizeEnumValues(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseMysqlEnumValues(columnType: unknown): string[] | null {
  if (typeof columnType !== "string") return null;
  const trimmed = columnType.trim();
  if (!trimmed.toLowerCase().startsWith("enum(") || !trimmed.endsWith(")")) return null;

  const inner = trimmed.slice(5, -1);
  const values: string[] = [];
  let index = 0;

  const skipWhitespace = () => {
    while (index < inner.length && /\s/.test(inner[index] ?? "")) index += 1;
  };

  while (index < inner.length) {
    skipWhitespace();
    if (inner[index] !== "'") return null;
    index += 1;

    let value = "";
    while (index < inner.length) {
      const char = inner[index++];
      if (char === "'") {
        if (inner[index] === "'") {
          value += "'";
          index += 1;
          continue;
        }
        break;
      }
      if (char === "\\") {
        if (index >= inner.length) return null;
        const escaped = inner[index++];
        if (escaped === "0") value += "\0";
        else if (escaped === "b") value += "\b";
        else if (escaped === "n") value += "\n";
        else if (escaped === "r") value += "\r";
        else if (escaped === "t") value += "\t";
        else if (escaped === "Z") value += "\x1a";
        else value += escaped;
        continue;
      }
      value += char;
    }
    values.push(value);

    skipWhitespace();
    if (index >= inner.length) return values;
    if (inner[index] !== ",") return null;
    index += 1;
  }

  return values;
}

function mapDescribeTableColumn(
  row: {
    name?: unknown;
    data_type?: unknown;
    is_nullable?: unknown;
    column_default?: unknown;
    is_primary_key?: unknown;
    comment?: unknown;
    numeric_precision?: number | null;
    numeric_scale?: number | null;
    character_maximum_length?: number | null;
    character_set?: string | null;
    collation?: string | null;
  },
  enumValues: string[] | null,
): ColumnInfo {
  const column: ColumnInfo = {
    name: String(row.name || ""),
    data_type: String(row.data_type || ""),
    is_nullable: Boolean(row.is_nullable),
    column_default: row.column_default != null ? String(row.column_default) : null,
    is_primary_key: Boolean(row.is_primary_key),
    comment: row.comment != null ? String(row.comment) : null,
    enum_values: enumValues,
  };
  if ("numeric_precision" in row) column.numeric_precision = row.numeric_precision;
  if ("numeric_scale" in row) column.numeric_scale = row.numeric_scale;
  if ("character_maximum_length" in row) column.character_maximum_length = row.character_maximum_length;
  if ("character_set" in row) column.character_set = row.character_set ?? null;
  if ("collation" in row) column.collation = row.collation ?? null;
  return column;
}

export function collectionListToTableInfos(collections: CollectionListEntry[]): TableInfo[] {
  return collections.map((collection) => ({
    name: typeof collection === "string" ? collection : collection.name,
    type: "COLLECTION",
  }));
}

interface MongoDocumentResult {
  documents: unknown[];
  total: number;
}

async function bridgeDataRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let bridgeUrl: string;
  try {
    const port = (await readFile(bridgePortFilePath(), "utf-8")).trim();
    bridgeUrl = `http://127.0.0.1:${port}`;
  } catch {
    throw new Error("DBX desktop app is not running. This database type requires DBX to be running for query execution.");
  }
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let errorMsg: string;
    try {
      const parsed = JSON.parse(errBody);
      errorMsg = parsed.error || errBody;
    } catch {
      errorMsg = errBody;
    }
    throw new Error(errorMsg || `Bridge request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function resolveMaxRows(options?: QueryOptions): number {
  return options?.maxRows ?? MAX_ROWS;
}

function resolveTimeoutMs(options?: QueryOptions): number {
  return options?.timeoutMs ?? QUERY_TIMEOUT_MS;
}

function convertBridgeQueryResult(result: BridgeQueryResult, options?: QueryOptions): QueryResult {
  const rows = result.rows.slice(0, resolveMaxRows(options)).map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  return { columns: result.columns, rows, row_count: rows.length };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function queryWithRetry(config: ConnectionConfig, fn: () => Promise<QueryResult>, options?: QueryOptions): Promise<QueryResult> {
  const timeoutMs = resolveTimeoutMs(options);
  try {
    return await withTimeout(fn(), timeoutMs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const retriable = /terminating connection|Connection lost|ECONNRESET|EPIPE|connection refused/i.test(msg);
    if (retriable) {
      const key = poolKey(config);
      const entry = pools.get(key);
      if (entry) evictPool(key, entry);
      return withTimeout(fn(), timeoutMs);
    }
    throw e;
  }
}

async function pgQuery(config: ConnectionConfig, sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult> {
  return queryWithRetry(
    config,
    async () => {
      const pool = await getPgPool(config);
      const result = await pool.query(sql, params);
      const rows = (result.rows || []).slice(0, resolveMaxRows(options));
      return { columns: result.fields?.map((f) => f.name) ?? [], rows, row_count: rows.length };
    },
    options,
  );
}

async function mysqlQuery(config: ConnectionConfig, sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult> {
  return queryWithRetry(
    config,
    async () => {
      const pool = await getMysqlPool(config);
      const [results, fields] = await pool.query(sql, params);
      const rows = (Array.isArray(results) ? results : []).slice(0, resolveMaxRows(options)) as Record<string, unknown>[];
      return { columns: (fields as Array<{ name: string }>)?.map((f) => f.name) ?? [], rows, row_count: rows.length };
    },
    options,
  );
}

async function query(config: ConnectionConfig, sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult> {
  if (config.db_type === "sqlite") return sqliteQuery(config, sql, options);
  if (config.db_type === "rqlite") return rqliteQuery(config, sql, options);
  if (isMysqlType(config.db_type)) return mysqlQuery(config, sql, params, options);
  return pgQuery(config, sql, params, options);
}

function sqlitePath(config: ConnectionConfig): string {
  return expandTilde(config.host || config.database || "");
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqliteQuery(config: ConnectionConfig, sql: string, options?: QueryOptions): QueryResult {
  const db = new Database(sqlitePath(config), { readonly: !sqlSafetyFromEnv().allowWrites });
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all().slice(0, resolveMaxRows(options)) as Record<string, unknown>[];
      return { columns: stmt.columns().map((column) => column.name), rows, row_count: rows.length };
    }
    const result = stmt.run();
    return { columns: [], rows: [], row_count: result.changes };
  } finally {
    db.close();
  }
}

async function rqliteQuery(config: ConnectionConfig, sql: string, options?: QueryOptions): Promise<QueryResult> {
  const isReader = /^\s*(?:--[^\n]*\n|\s|\/\*[\s\S]*?\*\/)*(select|pragma|explain|with)\b/i.test(sql);
  const endpoint = isReader ? "/db/query" : "/db/execute";
  const result = await rqliteRequest(config, endpoint, sql);
  if (isReader) {
    const columns = result.columns ?? [];
    const rows = (result.values ?? []).slice(0, resolveMaxRows(options)).map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        record[column] = row[index];
      });
      return record;
    });
    return { columns, rows, row_count: rows.length };
  }
  return { columns: [], rows: [], row_count: result.rows_affected ?? 0 };
}

async function rqliteRequest(config: ConnectionConfig, endpoint: "/db/query" | "/db/execute", sql: string): Promise<RqliteResult> {
  const { host, port } = await connectionEndpoint(config);
  const scheme = config.ssl ? "https" : "http";
  const params = (config.url_params || "").trim().replace(/^\?/, "");
  const url = `${scheme}://${host}:${port}${endpoint}${params ? `?${params}` : ""}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.username) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password || ""}`).toString("base64")}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify([sql]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`rqlite error (${response.status}): ${text}`);
  const payload = JSON.parse(text) as RqliteResponse;
  const result = payload.results?.[0];
  if (!result) throw new Error("rqlite returned no result");
  if (result.error) throw new Error(`rqlite error: ${result.error}`);
  return result;
}

export async function executeQuery(config: ConnectionConfig, sql: string, options?: QueryOptions): Promise<QueryResult> {
  if (hasActiveSshLayer(config)) {
    const result = await withTimeout(
      bridgeDataRequest<BridgeQueryResult>("/data/execute-query", {
        connection_id: config.id,
        connection_name: config.name,
        database: config.database || "",
        sql,
      }),
      resolveTimeoutMs(options),
    );
    return convertBridgeQueryResult(result, options);
  }
  if (config.db_type === "mongodb") {
    const version = parseMongoVersionCommand(sql);
    if (version) {
      const result = await withTimeout(mongoServerVersion(config), resolveTimeoutMs(options));
      return { columns: ["version"], rows: [{ version: result }], row_count: 1 };
    }
    const count = parseMongoCountDocumentsCommand(sql);
    if (count) {
      const total = await withTimeout(mongoCountDocuments(config, count.collection, count.filter, count.mode), resolveTimeoutMs(options));
      return { columns: ["count"], rows: [{ count: total }], row_count: 1 };
    }
    const find = parseMongoFindCommand(sql);
    if (find) {
      const result = await withTimeout(mongoFindDocuments(config, find.collection, find.skip, find.limit, find.filter, find.projection, find.sort), resolveTimeoutMs(options));
      return mongoDocumentsToQueryResult(result.documents.slice(0, resolveMaxRows(options)), result.total);
    }
    const aggregate = parseMongoAggregateCommand(sql);
    if (aggregate) {
      const safety = evaluateMongoAggregateSafety(aggregate, sqlSafetyFromEnv());
      if (!safety.allowed) throw new Error(safety.reason);
      const result = await withTimeout(mongoAggregateDocuments(config, aggregate.collection, aggregate.pipeline, resolveMaxRows(options)), resolveTimeoutMs(options));
      return mongoDocumentsToQueryResult(result.documents.slice(0, resolveMaxRows(options)), result.total);
    }
    const distinct = parseMongoDistinctCommand(sql);
    if (distinct) {
      const result = await withTimeout(mongoDistinct(config, distinct.collection, distinct.field, distinct.filter), resolveTimeoutMs(options));
      return mongoDistinctToQueryResult(distinct.field, result.documents.slice(0, resolveMaxRows(options)));
    }
    const getIndexes = parseMongoGetIndexesCommand(sql);
    if (getIndexes) {
      const result = await withTimeout(mongoAggregateDocuments(config, getIndexes.collection, '[{"$indexStats":{}}]', resolveMaxRows(options)), resolveTimeoutMs(options));
      return mongoDocumentsToQueryResult(result.documents.slice(0, resolveMaxRows(options)), result.total);
    }
    const collectionStats = parseMongoCollectionStatsCommand(sql);
    if (collectionStats) {
      const result = await withTimeout(mongoCollectionStats(config, collectionStats.collection, collectionStats.scale), resolveTimeoutMs(options));
      return mongoCollectionStatsToQueryResult(collectionStats.metric, result);
    }
    const write = parseMongoWriteCommand(sql);
    if (write) {
      const safety = evaluateMongoWriteSafety(write, sqlSafetyFromEnv());
      if (!safety.allowed) throw new Error(safety.reason);
      const result = await withTimeout(executeMongoWrite(config, write), resolveTimeoutMs(options));
      if (write.kind === "createIndex") {
        return {
          columns: ["name"],
          rows: [{ name: result.indexName ?? "" }],
          row_count: 1,
        };
      }
      if (write.kind === "dropIndex" || write.kind === "dropIndexes") {
        return {
          columns: ["name"],
          rows: (result.droppedNames ?? []).map((name) => ({ name })),
          row_count: result.affectedRows,
        };
      }
      return { columns: [], rows: [], row_count: result.affectedRows };
    }
    throw new Error(
      'Use MongoDB shell-style commands, for example: db.projects.find({}).limit(100), db.version(), db.projects.countDocuments({}), db.projects.count({}), db.projects.distinct("status"), db.projects.getIndexes(), db.projects.dataSize(), db.projects.storageSize(1024), db.projects.totalIndexSize(), db.projects.stats(), db.projects.createIndex({...}), db.projects.dropIndex("name"), db.projects.dropIndexes(), db.projects.drop(), db.projects.insertOne({...}), db.projects.updateOne({...}, {$set: {...}}), or db.projects.deleteOne({...})',
    );
  }
  if (isDirectQueryType(config.db_type)) {
    return query(config, sql, undefined, options);
  }
  const result = await withTimeout(
    bridgeDataRequest<BridgeQueryResult>("/data/execute-query", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      sql,
    }),
    resolveTimeoutMs(options),
  );
  return convertBridgeQueryResult(result, options);
}

export async function executeRedisCommand(config: ConnectionConfig, db: number, command: string, options?: RedisCommandOptions): Promise<RedisCommandResult> {
  if (config.db_type !== "redis") {
    throw new Error("Connection is not Redis.");
  }
  if (hasDirectRedisSupport(config)) {
    return executeRedisCommandDirect(config, db, command, options);
  }
  return withTimeout(
    bridgeDataRequest<RedisCommandResult>("/data/redis/execute-command", {
      connection_id: config.id,
      connection_name: config.name,
      db,
      command,
      skip_safety_check: options?.skipSafetyCheck ?? false,
    }),
    resolveTimeoutMs(options),
  );
}

async function executeRedisCommandDirect(config: ConnectionConfig, db: number, commandText: string, options?: RedisCommandOptions): Promise<RedisCommandResult> {
  const argv = parseRedisCommandArgv(commandText);
  const command = argv[0].toUpperCase();
  const safety = classifyRedisCommand(command) as RedisCommandSafety;
  if (!options?.skipSafetyCheck && safety === "blocked") {
    throw new Error("Redis command is blocked for safety. Enable dangerous commands with DBX_MCP_ALLOW_DANGEROUS_SQL=1.");
  }

  const { Redis } = await import("ioredis");
  const endpoint = await connectionEndpoint(config);
  const tls = await redisTlsOptions(config);
  const client = new Redis({
    host: endpoint.host,
    port: endpoint.port,
    username: config.username || undefined,
    password: config.password || undefined,
    db,
    tls,
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: Math.min(resolveTimeoutMs(options), 10_000),
    commandTimeout: resolveTimeoutMs(options),
  });

  try {
    await client.connect();
    const value = await client.call(command, ...argv.slice(1));
    return { command, safety, value: redisValueToJson(value) };
  } finally {
    client.disconnect();
  }
}

async function redisTlsOptions(config: ConnectionConfig): Promise<import("node:tls").ConnectionOptions | undefined> {
  if (!config.ssl) return undefined;
  const params = urlParams(config);
  const tls: import("node:tls").ConnectionOptions = {
    servername: config.host,
  };
  if ((params.get("insecure") || "").toLowerCase() === "true") {
    tls.rejectUnauthorized = false;
  }
  if (config.ca_cert_path) tls.ca = await readFile(config.ca_cert_path);
  if (config.client_cert_path) tls.cert = await readFile(config.client_cert_path);
  if (config.client_key_path) tls.key = await readFile(config.client_key_path);
  return tls;
}

function redisValueToJson(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return redisTextToJson(value.toString("utf8"));
  if (Array.isArray(value)) return value.map(redisValueToJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redisValueToJson(item)]));
  }
  if (typeof value === "string") return redisTextToJson(value);
  return value;
}

function redisTextToJson(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export async function listTables(config: ConnectionConfig, schema?: string): Promise<TableInfo[]> {
  if (config.db_type === "mongodb") {
    const collections = await bridgeDataRequest<CollectionListEntry[]>("/data/mongo/list-collections", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      schema: schema || "",
    });
    return collectionListToTableInfos(collections);
  }
  if (config.db_type === "sqlite" || config.db_type === "rqlite") {
    const result = await query(config, `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    return result.rows.map((r) => ({ name: String(r.name || ""), type: String(r.type || "table") }));
  }
  if (hasActiveSshLayer(config) || !isDirectQueryType(config.db_type)) {
    const tables = await bridgeDataRequest<BridgeTableInfo[]>("/data/list-tables", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      schema: schema || "",
    });
    return tables.map((t) => ({ name: t.name, type: t.table_type || "TABLE" }));
  }
  let result: QueryResult;
  if (isMysqlType(config.db_type)) {
    result = await query(config, `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
  } else {
    result = await query(config, `SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema || "public"]);
  }
  return result.rows.map((r) => ({ name: String(r.name || r.NAME), type: String(r.type || r.TYPE || "TABLE") }));
}

export async function describeTable(config: ConnectionConfig, table: string, schema?: string): Promise<ColumnInfo[]> {
  if (config.db_type === "mongodb") {
    const result = await mongoFindDocuments(config, table, 0, 20, "{}");
    return inferMongoColumns(result.documents);
  }
  if (config.db_type === "sqlite" || config.db_type === "rqlite") {
    const result = await query(config, `PRAGMA table_info(${quoteSqliteIdentifier(table)})`);
    return result.rows.map((r) => ({
      name: String(r.name || ""),
      data_type: String(r.type || ""),
      is_nullable: Number(r.notnull || 0) === 0,
      column_default: r.dflt_value != null ? String(r.dflt_value) : null,
      is_primary_key: Number(r.pk || 0) > 0,
      comment: null,
    }));
  }
  if (hasActiveSshLayer(config) || !isDirectQueryType(config.db_type)) {
    const columns = await bridgeDataRequest<BridgeColumnInfo[]>("/data/describe-table", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      schema: schema || "",
      table,
    });
    return columns.map((column) => mapDescribeTableColumn(column, column.enum_values ?? null));
  }
  let result: QueryResult;
  if (isMysqlType(config.db_type)) {
    result = await query(config, MYSQL_DESCRIBE_TABLE_SQL, [table]);
    return result.rows.map((row) => mapDescribeTableColumn(row, String(row.data_type || "").toLowerCase() === "enum" ? parseMysqlEnumValues(row.column_type) : null));
  } else if (config.db_type === "postgres") {
    try {
      result = await query(config, POSTGRES_DESCRIBE_TABLE_SQL, [schema || "public", table]);
    } catch {
      result = await query(config, POSTGRES_DESCRIBE_TABLE_COMPAT_SQL, [schema || "public", table]);
    }
  } else {
    result = await query(config, POSTGRES_DESCRIBE_TABLE_COMPAT_SQL, [schema || "public", table]);
  }
  return result.rows.map((row) => mapDescribeTableColumn(row, normalizeEnumValues(row.enum_values)));
}

async function mongoFindDocuments(config: ConnectionConfig, collection: string, skip: number, limit: number, filter: string, projection?: string, sort?: string): Promise<MongoDocumentResult> {
  return bridgeDataRequest<MongoDocumentResult>("/data/mongo/find-documents", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection,
    skip,
    limit,
    filter,
    projection,
    sort,
  });
}

async function mongoCountDocuments(config: ConnectionConfig, collection: string, filter: string, mode: MongoCountDocumentsCommand["mode"]): Promise<number> {
  return bridgeDataRequest<number>("/data/mongo/count-documents", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection,
    filter,
    mode,
  });
}

async function mongoServerVersion(config: ConnectionConfig): Promise<string> {
  return bridgeDataRequest<string>("/data/mongo/server-version", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
  });
}

async function mongoCollectionStats(config: ConnectionConfig, collection: string, scale?: number): Promise<Record<string, unknown>> {
  return bridgeDataRequest<Record<string, unknown>>("/data/mongo/collection-stats", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection,
    scale,
  });
}

async function executeMongoWrite(config: ConnectionConfig, command: MongoWriteCommand): Promise<{ affectedRows: number; indexName?: string; droppedNames?: string[] }> {
  if (command.kind === "insert") {
    const result = await bridgeDataRequest<{ affected_rows: number }>("/data/mongo/insert-documents", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      collection: command.collection,
      docs_json: command.docsJson,
    });
    return { affectedRows: result.affected_rows };
  }
  if (command.kind === "update") {
    const result = await bridgeDataRequest<{ affected_rows: number }>("/data/mongo/update-documents", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      collection: command.collection,
      filter_json: command.filter,
      update_json: command.update,
      many: command.many,
      options_json: command.options,
    });
    return { affectedRows: result.affected_rows };
  }
  if (command.kind === "createIndex") {
    const result = await bridgeDataRequest<{ name: string }>("/data/mongo/create-index", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      collection: command.collection,
      keys_json: command.keys,
      options_json: command.options,
    });
    return { affectedRows: 1, indexName: result.name };
  }
  if (command.kind === "dropIndex" || command.kind === "dropIndexes") {
    const result = await bridgeDataRequest<{ dropped_names: string[]; affected_rows: number }>("/data/mongo/drop-indexes", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      collection: command.collection,
      indexes_json: command.kind === "dropIndex" ? command.index : command.indexes,
      single: command.kind === "dropIndex",
    });
    return { affectedRows: result.affected_rows, droppedNames: result.dropped_names };
  }
  if (command.kind === "dropCollection") {
    await bridgeDataRequest<{ ok: boolean }>("/data/mongo/drop-collection", {
      connection_id: config.id,
      connection_name: config.name,
      database: config.database || "",
      collection: command.collection,
    });
    return { affectedRows: 1 };
  }
  const result = await bridgeDataRequest<{ affected_rows: number }>("/data/mongo/delete-documents", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection: command.collection,
    filter_json: command.filter,
    many: command.many,
  });
  return { affectedRows: result.affected_rows };
}

async function mongoAggregateDocuments(config: ConnectionConfig, collection: string, pipelineJson: string, maxRows: number): Promise<MongoDocumentResult> {
  return bridgeDataRequest<MongoDocumentResult>("/data/mongo/aggregate-documents", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection,
    pipeline_json: pipelineJson,
    max_rows: maxRows,
  });
}

async function mongoDistinct(config: ConnectionConfig, collection: string, field: string, filter?: string): Promise<MongoDocumentResult> {
  return bridgeDataRequest<MongoDocumentResult>("/data/mongo/distinct", {
    connection_id: config.id,
    connection_name: config.name,
    database: config.database || "",
    collection,
    field,
    filter,
  });
}

/** distinct returns bare values, so the single column is named after the field. */
export function mongoDistinctToQueryResult(field: string, values: unknown[]): QueryResult {
  return {
    columns: [field],
    rows: values.map((value) => ({ [field]: toCellValue(value) })),
    row_count: values.length,
  };
}

export function mongoCollectionStatsToQueryResult(metric: MongoCollectionStatsMetric, stats: Record<string, unknown>): QueryResult {
  if (metric === "stats") {
    const columns = ["count", "size", "avgObjSize", "storageSize", "totalIndexSize", "nindexes"];
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      row[column] = column in stats ? toCellValue(stats[column]) : null;
    }
    return { columns, rows: [row], row_count: 1 };
  }
  const sourceField = metric === "dataSize" ? "size" : metric;
  return {
    columns: [metric],
    rows: [{ [metric]: sourceField in stats ? toCellValue(stats[sourceField]) : null }],
    row_count: 1,
  };
}

export function mongoDocumentsToQueryResult(documents: unknown[], _total: number): QueryResult {
  const columns: string[] = [];
  for (const doc of documents) {
    if (isRecord(doc)) {
      for (const key of Object.keys(doc)) {
        if (!columns.includes(key)) columns.push(key);
      }
    } else if (!columns.includes("value")) {
      columns.push("value");
    }
  }
  const rows = documents.map((doc) => {
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      row[column] = isRecord(doc) ? toCellValue(doc[column]) : column === "value" ? toCellValue(doc) : null;
    }
    return row;
  });
  return { columns, rows, row_count: rows.length };
}

export function inferMongoColumns(documents: unknown[]): ColumnInfo[] {
  const columns = new Map<string, { types: Set<string>; nullable: boolean }>();
  for (const doc of documents) {
    if (!isRecord(doc)) {
      const entry = columns.get("value") ?? { types: new Set<string>(), nullable: false };
      entry.types.add(mongoTypeName(doc));
      columns.set("value", entry);
      continue;
    }
    for (const [name, value] of Object.entries(doc)) {
      const entry = columns.get(name) ?? { types: new Set<string>(), nullable: false };
      entry.types.add(mongoTypeName(value));
      if (value === null || value === undefined) entry.nullable = true;
      columns.set(name, entry);
    }
  }
  return Array.from(columns.entries()).map(([name, entry]) => ({
    name,
    data_type: Array.from(entry.types).sort().join(" | ") || "unknown",
    is_nullable: entry.nullable,
    column_default: null,
    is_primary_key: name === "_id",
    comment: null,
  }));
}

interface MongoFindCommand {
  collection: string;
  filter: string;
  projection?: string;
  skip: number;
  limit: number;
  sort?: string;
}

interface MongoCountDocumentsCommand {
  collection: string;
  filter: string;
  mode: "accurate" | "legacy";
}

interface MongoAggregateCommand {
  collection: string;
  pipeline: string;
}

interface MongoDistinctCommand {
  collection: string;
  field: string;
  filter?: string;
}

interface MongoGetIndexesCommand {
  collection: string;
}

type MongoCollectionStatsMetric = "stats" | "dataSize" | "storageSize" | "totalIndexSize";

interface MongoCollectionStatsCommand {
  collection: string;
  metric: MongoCollectionStatsMetric;
  scale?: number;
}

export type MongoWriteCommand =
  | { kind: "insert"; collection: string; docsJson: string }
  | { kind: "update"; collection: string; filter: string; update: string; options?: string; many: boolean }
  | { kind: "delete"; collection: string; filter: string; many: boolean }
  | { kind: "createIndex"; collection: string; keys: string; options?: string }
  | { kind: "dropIndex"; collection: string; index: string }
  | { kind: "dropIndexes"; collection: string; indexes?: string }
  | { kind: "dropCollection"; collection: string };

export function parseMongoFindCommand(input: string): MongoFindCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "find");
  if (!target) return null;
  const findOpenIndex = source.indexOf("(", target.methodCallIndex);
  const findCloseIndex = findMatchingParen(source, findOpenIndex);
  if (findCloseIndex < 0) return null;
  const findArgs = splitTopLevel(source.slice(findOpenIndex + 1, findCloseIndex));
  if (findArgs.length > 2 && findArgs.slice(2).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(findArgs[0] || "{}");
  if (!filter) return null;
  let projection: string | undefined;
  if (findArgs[1]?.trim()) {
    const parsedProjection = normalizeJsonArgument(findArgs[1]);
    if (!parsedProjection) return null;
    projection = parsedProjection;
  }
  const chain = source.slice(findCloseIndex + 1).trim();
  if (chain && !chain.startsWith(".")) return null;
  if (findChainedMethodCallIndex(chain, "count") >= 0) return null;
  const sortArg = readChainedCallArgument(chain, "sort");
  let sort: string | undefined;
  if (sortArg !== undefined) {
    const parsedSort = normalizeJsonArgument(sortArg);
    if (!parsedSort) return null;
    sort = parsedSort;
  }
  const skip = readChainedIntegerArgument(chain, "skip", 0);
  const limit = readChainedIntegerArgument(chain, "limit", MAX_ROWS);
  if (skip === null || limit === null) return null;
  return { collection: target.collection, filter, ...(projection ? { projection } : {}), skip, limit, sort };
}

export function parseMongoVersionCommand(input: string): boolean {
  const source = input.trim().replace(/;$/, "").trim();
  return /^db\s*\.\s*version\s*\(\s*\)$/i.test(source);
}

export function parseMongoCountDocumentsCommand(input: string): MongoCountDocumentsCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  return parseCollectionCountCommand(source, "countDocuments") ?? parseCollectionCountCommand(source, "count") ?? parseFindCountCommand(source);
}

function parseCollectionCountCommand(source: string, method: "countDocuments" | "count"): MongoCountDocumentsCommand | null {
  const target = parseCollectionMethodTarget(source, method);
  if (!target) return null;
  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;
  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.length > 1 && args.slice(1).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(args[0] || "{}");
  return filter ? { collection: target.collection, filter, mode: method === "countDocuments" ? "accurate" : "legacy" } : null;
}

function parseFindCountCommand(source: string): MongoCountDocumentsCommand | null {
  const target = parseCollectionMethodTarget(source, "find");
  if (!target) return null;
  const findOpenIndex = source.indexOf("(", target.methodCallIndex);
  const findCloseIndex = findMatchingParen(source, findOpenIndex);
  if (findCloseIndex < 0) return null;
  const chain = source.slice(findCloseIndex + 1).trim();
  if (!hasSingleEmptyChainedCall(chain, "count")) return null;
  const findArgs = splitTopLevel(source.slice(findOpenIndex + 1, findCloseIndex));
  if (findArgs.length > 2 && findArgs.slice(2).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(findArgs[0] || "{}");
  return filter ? { collection: target.collection, filter, mode: "legacy" } : null;
}

export function parseMongoAggregateCommand(input: string): MongoAggregateCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "aggregate");
  if (!target) return null;
  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.length !== 1) return null;
  const pipeline = normalizeJsonArgument(args[0]);
  if (!pipeline) return null;
  return Array.isArray(JSON.parse(pipeline)) ? { collection: target.collection, pipeline } : null;
}

export function parseMongoDistinctCommand(input: string): MongoDistinctCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "distinct");
  if (!target) return null;
  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.length < 1 || args.length > 2) return null;

  const fieldJson = normalizeJsonArgument(args[0] ?? "");
  if (!fieldJson) return null;
  let field: unknown;
  try {
    field = JSON.parse(fieldJson);
  } catch {
    return null;
  }
  if (typeof field !== "string" || !field.trim()) return null;

  if (args.length === 1) return { collection: target.collection, field };
  const filter = normalizeJsonArgument(args[1] ?? "");
  return filter ? { collection: target.collection, field, filter } : null;
}

export function parseMongoGetIndexesCommand(input: string): MongoGetIndexesCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "getIndexes");
  if (!target) return null;
  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.some((arg) => arg.trim())) return null;
  return { collection: target.collection };
}

export function parseMongoCollectionStatsCommand(input: string): MongoCollectionStatsCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  for (const metric of ["stats", "dataSize", "storageSize", "totalIndexSize"] as const) {
    const target = parseCollectionMethodTarget(source, metric);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args) return null;
    const scale = parseMongoCollectionStatsScale(args);
    return scale === null ? null : { collection: target.collection, metric, ...(scale === undefined ? {} : { scale }) };
  }
  return null;
}

export function mongoAggregateWriteStage(pipelineJson: string): "$out" | "$merge" | null {
  try {
    const pipeline = JSON.parse(pipelineJson);
    if (!Array.isArray(pipeline)) return null;
    for (const stage of pipeline) {
      if (!isRecord(stage)) continue;
      if (Object.prototype.hasOwnProperty.call(stage, "$out")) return "$out";
      if (Object.prototype.hasOwnProperty.call(stage, "$merge")) return "$merge";
    }
    return null;
  } catch {
    return null;
  }
}

export function parseMongoWriteCommand(input: string): MongoWriteCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const insertOne = parseCollectionMethodTarget(source, "insertOne");
  if (insertOne) {
    const args = parseMethodArgs(source, insertOne.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const doc = normalizeJsonArgument(args[0]);
    return doc ? { kind: "insert", collection: insertOne.collection, docsJson: doc } : null;
  }

  const insertMany = parseCollectionMethodTarget(source, "insertMany");
  if (insertMany) {
    const args = parseMethodArgs(source, insertMany.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const docs = normalizeJsonArgument(args[0]);
    if (!docs) return null;
    return Array.isArray(JSON.parse(docs)) ? { kind: "insert", collection: insertMany.collection, docsJson: docs } : null;
  }

  for (const method of ["updateOne", "updateMany"] as const) {
    const target = parseCollectionMethodTarget(source, method);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args || args.length < 2 || args.length > 3) return null;
    const filter = normalizeJsonArgument(args[0]);
    const update = normalizeJsonArgument(args[1]);
    if (!filter || !update) return null;
    const options = args[2]?.trim() ? normalizeJsonArgument(args[2]) : undefined;
    if (args[2]?.trim() && !options) return null;
    return { kind: "update", collection: target.collection, filter, update, ...(options ? { options } : {}), many: method === "updateMany" };
  }

  for (const method of ["deleteOne", "deleteMany"] as const) {
    const target = parseCollectionMethodTarget(source, method);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const filter = normalizeJsonArgument(args[0]);
    if (!filter) return null;
    return { kind: "delete", collection: target.collection, filter, many: method === "deleteMany" };
  }

  const createIndex = parseCollectionMethodTarget(source, "createIndex");
  if (createIndex) {
    const args = parseMethodArgs(source, createIndex.methodCallIndex);
    if (!args || args.length < 1 || args.length > 2) return null;
    const keys = normalizeJsonArgument(args[0]);
    if (!keys) return null;
    let options: string | undefined;
    if (args[1]?.trim()) {
      const parsedOptions = normalizeJsonArgument(args[1]);
      if (!parsedOptions) return null;
      options = parsedOptions;
    }
    return { kind: "createIndex", collection: createIndex.collection, keys, ...(options ? { options } : {}) };
  }

  const dropIndex = parseCollectionMethodTarget(source, "dropIndex");
  if (dropIndex) {
    const args = parseMethodArgs(source, dropIndex.methodCallIndex);
    if (!args) return null;
    const index = parseMongoDropIndexArgument(args);
    return index ? { kind: "dropIndex", collection: dropIndex.collection, index } : null;
  }

  const dropIndexes = parseCollectionMethodTarget(source, "dropIndexes");
  if (dropIndexes) {
    const args = parseMethodArgs(source, dropIndexes.methodCallIndex);
    if (!args) return null;
    const indexes = parseMongoDropIndexesArgument(args);
    return indexes !== null ? { kind: "dropIndexes", collection: dropIndexes.collection, ...(indexes ? { indexes } : {}) } : null;
  }

  const dropCollection = parseCollectionMethodTarget(source, "drop");
  if (dropCollection) {
    const args = parseMethodArgs(source, dropCollection.methodCallIndex);
    if (!args || args.some((arg) => arg.trim())) return null;
    return { kind: "dropCollection", collection: dropCollection.collection };
  }

  return null;
}

export function evaluateMongoWriteSafety(command: MongoWriteCommand, options: { allowWrites?: boolean; allowDangerous?: boolean }): { allowed: boolean; reason?: string } {
  if (!options.allowWrites) {
    return {
      allowed: false,
      reason: "MCP MongoDB execution is read-only by default. Set DBX_MCP_ALLOW_WRITES=1 to allow write commands.",
    };
  }
  if (!options.allowDangerous && (command.kind === "update" || command.kind === "delete") && isEmptyJsonObject(command.filter)) {
    return {
      allowed: false,
      reason: "MongoDB update/delete commands must include a non-empty filter unless DBX_MCP_ALLOW_DANGEROUS_SQL=1 is set.",
    };
  }
  if (!options.allowDangerous && mongoDropIndexesRequiresDangerous(command)) {
    return {
      allowed: false,
      reason: "MongoDB dropIndexes() without a specific single index requires DBX_MCP_ALLOW_DANGEROUS_SQL=1.",
    };
  }
  if (!options.allowDangerous && command.kind === "dropCollection") {
    return {
      allowed: false,
      reason: "MongoDB drop() requires DBX_MCP_ALLOW_DANGEROUS_SQL=1.",
    };
  }
  return { allowed: true };
}

export function evaluateMongoAggregateSafety(command: MongoAggregateCommand, options: { allowWrites?: boolean; allowDangerous?: boolean }): { allowed: boolean; reason?: string } {
  const writeStage = mongoAggregateWriteStage(command.pipeline);
  if (!writeStage) return { allowed: true };
  if (!options.allowWrites) {
    return {
      allowed: false,
      reason: `MongoDB aggregate stage "${writeStage}" writes data. Set DBX_MCP_ALLOW_WRITES=1 to allow write commands.`,
    };
  }
  if (!options.allowDangerous) {
    return {
      allowed: false,
      reason: `MongoDB aggregate stage "${writeStage}" is dangerous. Set DBX_MCP_ALLOW_DANGEROUS_SQL=1 to allow it.`,
    };
  }
  return { allowed: true };
}

function parseCollectionMethodTarget(source: string, method: string): { collection: string; methodCallIndex: number } | null {
  const escapedMethod = escapeRegExp(method);
  const direct = new RegExp(`^db\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (direct) return { collection: direct[1], methodCallIndex: findChainedMethodCallIndex(source, method) };
  const quoted = new RegExp(`^db\\s*\\.\\s*getCollection\\s*\\(\\s*(['"])([^'"]+)\\1\\s*\\)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (quoted) return { collection: quoted[2], methodCallIndex: findChainedMethodCallIndex(source, method) };
  return null;
}

function parseMethodArgs(source: string, methodCallIndex: number): string[] | null {
  const openIndex = source.indexOf("(", methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;
  return splitTopLevel(source.slice(openIndex + 1, closeIndex));
}

function readChainedCallArgument(chain: string, method: string): string | undefined {
  const match = chainedMethodCallPattern(method).exec(chain);
  if (!match) return undefined;
  const openIndex = chain.indexOf("(", match.index);
  const closeIndex = findMatchingParen(chain, openIndex);
  return closeIndex < 0 ? undefined : chain.slice(openIndex + 1, closeIndex);
}

function hasSingleEmptyChainedCall(chain: string, method: string): boolean {
  const trimmed = chain.trim();
  const match = chainedMethodCallPattern(method).exec(trimmed);
  if (!match || match.index !== 0) return false;
  const openIndex = trimmed.indexOf("(", match.index);
  const closeIndex = findMatchingParen(trimmed, openIndex);
  return closeIndex >= 0 && !trimmed.slice(openIndex + 1, closeIndex).trim() && !trimmed.slice(closeIndex + 1).trim();
}

function findChainedMethodCallIndex(source: string, method: string): number {
  return chainedMethodCallPattern(method).exec(source)?.index ?? -1;
}

function chainedMethodCallPattern(method: string): RegExp {
  return new RegExp(`\\.\\s*${escapeRegExp(method)}\\s*\\(`, "g");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readChainedIntegerArgument(chain: string, method: string, fallback: number): number | null {
  const arg = readChainedCallArgument(chain, method);
  if (arg === undefined) return fallback;
  if (!/^\d+$/.test(arg.trim())) return null;
  return Number(arg.trim());
}

function normalizeJsonArgument(arg: string): string | null {
  const value = quoteUnquotedObjectKeys(convertSingleQuotedStrings((arg.trim() || "{}").replace(/ObjectId\s*\(\s*["']([^"']+)["']\s*\)/g, '{"$oid":"$1"}')));
  try {
    JSON.parse(value);
    return value;
  } catch {
    return null;
  }
}

function parseMongoDropIndexArgument(args: string[]): string | null {
  if (args.length !== 1 || !args[0]?.trim()) return null;
  const normalized = normalizeJsonArgument(args[0]);
  if (!normalized) return null;
  const parsed = parseNormalizedJson(normalized);
  if (typeof parsed === "string") return parsed === "*" ? null : normalized;
  return isNonEmptyRecord(parsed) ? normalized : null;
}

function parseMongoDropIndexesArgument(args: string[]): string | undefined | null {
  if (args.length !== 1) return null;
  if (!args[0]?.trim()) return undefined;
  const normalized = normalizeJsonArgument(args[0]);
  if (!normalized) return null;
  const parsed = parseNormalizedJson(normalized);
  if (typeof parsed === "string") return normalized;
  if (isNonEmptyRecord(parsed)) return normalized;
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string") ? normalized : null;
}

function parseMongoCollectionStatsScale(args: string[]): number | undefined | null {
  if (args.length === 1 && !args[0]?.trim()) return undefined;
  if (args.length !== 1) return null;
  const raw = args[0].trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const scale = Number(raw);
  if (!Number.isFinite(scale)) return null;
  return scale;
}

function convertSingleQuotedStrings(source: string): string {
  let result = "";
  let copiedUntil = 0;
  let quote: string | null = null;
  let start = 0;
  let value = "";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!quote) {
      if (char === "'") {
        quote = char;
        start = i;
        value = "";
        escaped = false;
      } else if (char === '"') {
        quote = char;
      }
      continue;
    }

    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }

    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      result += source.slice(copiedUntil, start) + JSON.stringify(value);
      copiedUntil = i + 1;
      quote = null;
    } else {
      value += char;
    }
  }

  return quote === "'" ? source : result + source.slice(copiedUntil);
}

function quoteUnquotedObjectKeys(source: string): string {
  let result = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (/[A-Za-z_$]/.test(char) && shouldQuoteObjectKey(source, i)) {
      let end = i + 1;
      while (/[\w$]/.test(source[end] || "")) end += 1;
      result += `"${source.slice(i, end)}"`;
      i = end - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function shouldQuoteObjectKey(source: string, index: number): boolean {
  let before = index - 1;
  while (/\s/.test(source[before] || "")) before -= 1;
  if (source[before] !== "{" && source[before] !== ",") return false;

  let after = index + 1;
  while (/[\w$]/.test(source[after] || "")) after += 1;
  while (/\s/.test(source[after] || "")) after += 1;
  return source[after] === ":";
}

function parseNormalizedJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isEmptyJsonObject(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function mongoDropIndexesRequiresDangerous(command: MongoWriteCommand): boolean {
  if (command.kind !== "dropIndexes") return false;
  if (!command.indexes) return true;
  const parsed = parseNormalizedJson(command.indexes);
  if (parsed === "*") return true;
  return Array.isArray(parsed) && parsed.length > 1;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function findMatchingParen(source: string, openIndex: number): number {
  if (openIndex < 0 || source[openIndex] !== "(") return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mongoTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return typeof value;
}

function toCellValue(value: unknown): unknown {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : value;
}
