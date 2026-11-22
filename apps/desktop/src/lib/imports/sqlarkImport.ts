import type { ConnectionConfig, DatabaseType, SidebarLayout } from "@/types/database";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import { uuid } from "@/lib/common/utils";
import { buildSidebarLayoutFromFolderPaths } from "@/lib/sidebar/sidebarLayout";
import { DEFAULT_QUERY_TIMEOUT_SECS } from "@/lib/connection/timeoutLimits";

/**
 * SQLark (https://www.sqlark.com) "导出配置" support.
 *
 * The export is a ZIP that holds `sqlark_setting.bak`: one base64 line per row of
 * SQLark's internal H2 database, each line being an AES-256-ECB/PKCS5 encrypted
 * `INSERT INTO ... VALUES (...)` statement. The key below is the constant SQLark
 * derives at runtime (a fixed string passed through a Caesar shift); it is the
 * same for every installation and every export, so an export is portable.
 *
 * Connection passwords are encrypted a second time with a per-connection 16-char
 * `salt` stored in the row itself: AES-128-CBC, key = salt, iv = reversed salt.
 */
const BACKUP_AES_KEY = "0123456789abcdef0123456789abcdef";
const SQLARK_SUPPORTED_MAJOR = 4;
/** Refuse pathological archives instead of inflating them into an unbounded parse. */
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

type PartialConnection = Omit<ConnectionConfig, "id">;

type Profile = { dbType: DatabaseType; profile: string; label: string; port: number; user: string };

/** SQLark `DB_TYPE` values, keyed by the string its H2 rows carry. */
const typeMap: Record<string, Profile> = {
  DM: { dbType: "dameng", profile: "dm", label: "达梦 Dameng", port: 5236, user: "SYSDBA" },
  DAMENG: { dbType: "dameng", profile: "dm", label: "达梦 Dameng", port: 5236, user: "SYSDBA" },
  MYSQL: { dbType: "mysql", profile: "mysql", label: "MySQL", port: 3306, user: "root" },
  MARIADB: { dbType: "mysql", profile: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  ORACLE: { dbType: "oracle", profile: "oracle", label: "Oracle", port: 1521, user: "system" },
  POSTGRESQL: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  POSTGRES: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  SQLSERVER: { dbType: "sqlserver", profile: "sqlserver", label: "SQL Server", port: 1433, user: "sa" },
  MONGODB: { dbType: "mongodb", profile: "mongodb", label: "MongoDB", port: 27017, user: "" },
  REDIS: { dbType: "redis", profile: "redis", label: "Redis", port: 6379, user: "" },
  OCEANBASE_MYSQL: { dbType: "mysql", profile: "oceanbase", label: "OceanBase", port: 2883, user: "root" },
  OCEANBASE_MYSQL_MODE: { dbType: "mysql", profile: "oceanbase", label: "OceanBase", port: 2883, user: "root" },
  OCEANBASE_ORACLE: { dbType: "oceanbase-oracle", profile: "oceanbase-oracle", label: "OceanBase Oracle Mode", port: 2883, user: "root" },
  KINGBASE: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  KINGBASEES: { dbType: "kingbase", profile: "kingbase", label: "KingbaseES", port: 54321, user: "SYSTEM" },
  GAUSSDB: { dbType: "gaussdb", profile: "gaussdb", label: "GaussDB", port: 8000, user: "root" },
  SQLITE: { dbType: "sqlite", profile: "sqlite", label: "SQLite", port: 0, user: "" },
};

export type SqlarkImportPayload = { format: "sqlark-import"; zipBase64: string };

export type SqlarkImportResult = ConnectionConfigBundle & {
  /** How many imported connections carry a recovered password. */
  passwordCount: number;
  /** Connections that were present but of an unsupported/unknown database type. */
  skippedCount: number;
  /** `-- VERSION:` from the backup header, for diagnostics. */
  version: string;
};

export function isSqlarkImportPayload(value: unknown): value is SqlarkImportPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SqlarkImportPayload>;
  return payload.format === "sqlark-import" && typeof payload.zipBase64 === "string" && payload.zipBase64.length > 0;
}

// ---------------------------------------------------------------------------
// ZIP reading
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("sqlark_invalid_zip");

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const { inflateRaw } = await import("pako");
  const entries = new Map<string, Uint8Array>();

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || localOffset + 30 > view.byteLength) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.byteLength) continue;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, raw);
    } else if (method === 8) {
      entries.set(name, inflateRaw(raw));
    }
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function entryBySuffix(entries: Map<string, Uint8Array>, suffix: string): Uint8Array | undefined {
  for (const [name, data] of entries) {
    if (name === suffix || name.endsWith(`/${suffix}`)) return data;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

let aesModule: Promise<typeof import("@noble/ciphers/aes.js")> | undefined;

/** One reusable AES-256-ECB decryptor; noble applies and validates PKCS#5 padding. */
async function createBackupDecryptor(): Promise<(line: string) => string> {
  const { ecb } = await (aesModule ??= import("@noble/ciphers/aes.js"));
  const cipher = ecb(new TextEncoder().encode(BACKUP_AES_KEY));
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return (line: string) => decoder.decode(cipher.decrypt(base64ToBytes(line)));
}

async function decryptConnectionPassword(encrypted: string, salt: string): Promise<string> {
  if (!encrypted || !salt) return "";
  let key: Uint8Array;
  let iv: Uint8Array;
  try {
    key = new TextEncoder().encode(salt);
    iv = new TextEncoder().encode(Array.from(salt).reverse().join(""));
  } catch {
    return "";
  }
  if (key.length !== 16 || iv.length !== 16) return "";
  const data = base64ToBytes(encrypted);

  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const cryptoKey = await subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "AES-CBC" }, false, ["decrypt"]);
      const plain = await subtle.decrypt({ name: "AES-CBC", iv: iv as Uint8Array<ArrayBuffer> }, cryptoKey, data as Uint8Array<ArrayBuffer>);
      return new TextDecoder().decode(plain);
    }
    const { cbc } = await (aesModule ??= import("@noble/ciphers/aes.js"));
    return new TextDecoder().decode(cbc(key, iv).decrypt(data));
  } catch {
    // A password that cannot be decrypted stays empty, so the user is prompted
    // for it on first connect instead of importing a wrong secret.
    return "";
  }
}

// ---------------------------------------------------------------------------
// SQL statement parsing
// ---------------------------------------------------------------------------

const INSERT_STATEMENT = /^\s*INSERT\s+INTO\s+([A-Za-z0-9_."$]+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*;?\s*$/i;

type SqlRow = Record<string, string | null>;

function splitSqlValues(input: string): (string | null)[] {
  const values: (string | null)[] = [];
  let index = 0;
  const length = input.length;

  while (index < length) {
    while (index < length && /\s/.test(input.charAt(index))) index += 1;
    if (index >= length) break;

    if (input.charAt(index) === "'") {
      index += 1;
      let text = "";
      while (index < length) {
        const char = input.charAt(index);
        if (char === "'") {
          if (input.charAt(index + 1) === "'") {
            text += "'";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        text += char;
        index += 1;
      }
      values.push(text);
    } else {
      const start = index;
      while (index < length && input.charAt(index) !== ",") index += 1;
      const raw = input.slice(start, index).trim();
      values.push(/^null$/i.test(raw) ? null : raw);
    }

    while (index < length && /\s/.test(input.charAt(index))) index += 1;
    if (input.charAt(index) === ",") {
      index += 1;
      continue;
    }
    break;
  }
  return values;
}

function parseInsertStatement(statement: string): { table: string; row: SqlRow } | null {
  const match = INSERT_STATEMENT.exec(statement);
  if (!match) return null;

  const table = (match[1].split(".").pop() ?? "").replace(/"/g, "").toUpperCase();
  const columns = match[2]
    .split(",")
    .map((column) => column.trim().replace(/"/g, "").toUpperCase())
    .filter((column) => column.length > 0);
  const values = splitSqlValues(match[3]);
  // A statement whose arity does not line up is a format change, not a row we
  // can safely guess at.
  if (columns.length === 0 || values.length !== columns.length) return null;

  const row: SqlRow = {};
  for (let index = 0; index < columns.length; index += 1) row[columns[index]] = values[index] ?? null;
  return { table, row };
}

function rowText(row: SqlRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function parseDetailJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function detailString(detail: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function detailNumber(detail: Record<string, unknown>, key: string): number | undefined {
  const value = detail[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function detailFlag(detail: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;
    if (typeof value === "string") return /^(1|true|yes|y|on)$/i.test(value.trim());
  }
  return false;
}

function inferProfile(dbType: string): Profile | null {
  const key = dbType
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (typeMap[key]) return typeMap[key];
  for (const [needle, profile] of Object.entries(typeMap)) {
    if (key.includes(needle)) return profile;
  }
  return null;
}

function normalizePort(value: string, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

// ---------------------------------------------------------------------------
// Group tree
// ---------------------------------------------------------------------------

type GroupNode = { id: string; parentId: string; name: string; sort: number };

function groupPaths(groups: Map<string, GroupNode>): Map<string, string> {
  const paths = new Map<string, string>();
  for (const id of groups.keys()) {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current: GroupNode | undefined = groups.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.name) segments.unshift(current.name);
      current = current.parentId && current.parentId !== "0" ? groups.get(current.parentId) : undefined;
    }
    if (segments.length > 0) paths.set(id, segments.join("/"));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Import entry point
// ---------------------------------------------------------------------------

export async function parseSqlarkImport(payload: SqlarkImportPayload): Promise<SqlarkImportResult> {
  const entries = await readZipEntries(base64ToBytes(payload.zipBase64)).catch(() => {
    throw new Error("Invalid SQLark backup archive");
  });
  const backupEntry = entryBySuffix(entries, "sqlark_setting.bak");
  if (!backupEntry) throw new Error("Not a SQLark configuration backup (sqlark_setting.bak is missing)");
  if (backupEntry.byteLength > MAX_BACKUP_BYTES) throw new Error("SQLark backup is too large to import");

  const backupText = new TextDecoder("utf-8", { fatal: false }).decode(backupEntry);
  const lines = backupText.split(/\r?\n/);
  const versionLine = lines.find((line) => /^\s*--\s*VERSION:/i.test(line));
  if (!versionLine) throw new Error("Not a SQLark configuration backup (missing VERSION header)");
  const version = (versionLine.split(":").slice(1).join(":") ?? "").trim();
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major !== SQLARK_SUPPORTED_MAJOR) {
    throw new Error(`Unsupported SQLark backup version ${version} (supported: ${SQLARK_SUPPORTED_MAJOR}.x)`);
  }

  const decrypt = await createBackupDecryptor();

  const connections: SqlRow[] = [];
  const connectionDetail = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, GroupNode>();
  const connectionGroupIds = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    let statement: string;
    try {
      statement = decrypt(trimmed);
    } catch {
      throw new Error("Could not decrypt the SQLark backup; its version may have changed or the file is damaged");
    }
    const parsed = parseInsertStatement(statement);
    if (!parsed) continue;
    const { table, row } = parsed;

    if (table === "CONNECTION_INFO") {
      // Rows carry both the flat columns and a JSON detail blob. The detail is
      // the richer source; keep it aside keyed by connection id.
      const id = rowText(row, "ID");
      const detail = parseDetailJson(rowText(row, "CONNECTION_DETAIL"));
      if (id) connectionDetail.set(id, detail);
      connections.push(row);
    } else if (table === "CONNECT_GROUP") {
      const id = rowText(row, "ID");
      if (!id) continue;
      groups.set(id, {
        id,
        parentId: rowText(row, "PID") || "0",
        name: rowText(row, "NAME"),
        sort: Number(rowText(row, "SORT")) || 0,
      });
    } else if (table === "CONNECT_GROUP_DETAIL") {
      const groupId = rowText(row, "GROUP_ID");
      const connectionId = rowText(row, "CONNECT_ID");
      if (groupId && connectionId && !connectionGroupIds.has(connectionId)) connectionGroupIds.set(connectionId, groupId);
    }
  }

  if (connections.length === 0) {
    throw new Error("The SQLark backup contains no database connections (the export did not include the DB_CONNECTION category)");
  }

  const resolvedGroupPaths = groupPaths(groups);
  const configs: ConnectionConfig[] = [];
  const connectionFolderPaths = new Map<string, string>();
  const seen = new Set<string>();
  let passwordCount = 0;
  let skippedCount = 0;

  for (const row of connections) {
    const id = rowText(row, "ID");
    const detail = (id ? connectionDetail.get(id) : undefined) ?? {};
    const rawType = rowText(row, "DB_TYPE") || detailString(detail, "dbType");
    const profile = inferProfile(rawType);
    if (!profile) {
      skippedCount += 1;
      console.warn(`[SQLark Import] Skipped connection with unsupported type: "${rowText(row, "CONNECTION_NAME")}" (type="${rawType}")`);
      continue;
    }

    const host = rowText(row, "HOST") || detailString(detail, "host");
    const port = normalizePort(rowText(row, "PORT") || detailString(detail, "port"), profile.port);
    const username = rowText(row, "USER_NAME") || detailString(detail, "user") || profile.user;
    const name = rowText(row, "CONNECTION_NAME") || `${host}:${port}`;
    const rememberPassword = !("rememberPassword" in detail) || detailFlag(detail, "rememberPassword");
    const salt = detailString(detail, "salt");
    const password = rememberPassword ? await decryptConnectionPassword(detailString(detail, "password"), salt) : "";
    if (password) passwordCount += 1;

    const dedupeKey = [name, profile.dbType, host, port, username].join("\u0000");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const keepaliveSeconds = detailFlag(detail, "keepAlive", "needKeepAlive") ? (detailNumber(detail, "keepAliveInterval") ?? 0) : 0;
    const database = detailString(detail, "database", "dbName", "defaultSchema");

    const config: PartialConnection = {
      name,
      db_type: profile.dbType,
      driver_profile: profile.profile,
      driver_label: profile.label,
      url_params: "",
      host,
      port,
      username,
      password,
      database: database || undefined,
      color: rowText(row, "COLOR"),
      transport_layers: [],
      connect_timeout_secs: 10,
      query_timeout_secs: DEFAULT_QUERY_TIMEOUT_SECS,
      keepalive_interval_secs: keepaliveSeconds,
      ssl: false,
      oracle_connection_type: undefined,
      connection_string: undefined,
      jdbc_driver_class: undefined,
      jdbc_driver_paths: [],
    };

    const configWithId: ConnectionConfig = { ...config, id: uuid() };
    configs.push(configWithId);

    const groupId = id ? connectionGroupIds.get(id) : undefined;
    const groupPath = groupId ? resolvedGroupPaths.get(groupId) : undefined;
    if (groupPath) connectionFolderPaths.set(configWithId.id, groupPath);
  }

  const layout: SidebarLayout | undefined = buildSidebarLayoutFromFolderPaths(
    configs.map((config) => config.id),
    new Set(connectionFolderPaths.values()),
    connectionFolderPaths,
  );

  return { connections: configs, layout, passwordCount, skippedCount, version };
}

/** Password-free convenience wrapper, mirroring the other importers. */
export async function parseSqlarkConnections(payload: SqlarkImportPayload): Promise<ConnectionConfig[]> {
  return (await parseSqlarkImport(payload)).connections;
}
