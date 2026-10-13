import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";
import { validateMongoOutputName } from "./mongoAggregation";

/** Deliberately bounded, append-only migration. No DDL, arbitrary SQL, or implicit coercion. */
export const MONGO_MIGRATION_SQL_TYPES = ["postgres", "mysql", "sqlite", "sqlserver"] as const;
export type MigrationSqlType = (typeof MONGO_MIGRATION_SQL_TYPES)[number];
export type MigrationDirection = "sqlToMongo" | "mongoToSql";
export type MigrationValueType = "auto" | "string" | "boolean" | "int64" | "decimal128" | "date" | "objectId" | "ejson";
export interface MongoMigrationMapping {
  source: string;
  target: string;
  type: MigrationValueType;
  array: "reject" | "json" | "first";
  missing: "error" | "null" | "omit";
}
export interface MigrationSqlEndpoint {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  dialect: MigrationSqlType;
}
export interface MigrationOperation {
  kind: "sql" | "mongo";
  text: string;
}
export const MIGRATION_MAX_ROWS = 1000;
export const MIGRATION_MAX_BYTES = 8 * 1024 * 1024;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const types = new Set(["auto", "string", "boolean", "int64", "decimal128", "date", "objectId", "ejson"]);
const wrappers = new Set(["$binary", "$code", "$date", "$dbPointer", "$maxKey", "$minKey", "$numberDecimal", "$numberDouble", "$numberInt", "$numberLong", "$oid", "$regularExpression", "$symbol", "$timestamp", "$undefined", "$uuid"]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function scalar(value: unknown) {
  return record(value) && Object.keys(value).some((key) => wrappers.has(key));
}
function pathParts(path: string): string[] {
  const parts = path.split(".");
  if (!path || parts.length > 32 || parts.some((part) => !part || forbidden.has(part) || part.startsWith("$") || [String.fromCharCode(0), "[", "]", "*"].some((character) => part.includes(character)))) throw new Error(`Invalid document path: ${path}`);
  return parts;
}
function identifier(name: string, dialect: MigrationSqlType): string {
  if (!name || [0, 13, 10].some((code) => name.includes(String.fromCharCode(code)))) throw new Error("A non-empty SQL identifier without control characters is required");
  if (dialect === "mysql") return `\`${name.replaceAll("`", "``")}\``;
  if (dialect === "sqlserver") return `[${name.replaceAll("]", "]]")}]`;
  return `"${name.replaceAll('"', '""')}"`;
}
function tableName(endpoint: MigrationSqlEndpoint) {
  if (endpoint.dialect === "mysql" && endpoint.schema && endpoint.schema !== endpoint.database) throw new Error("MySQL schema must match the selected database");
  if (endpoint.dialect === "sqlite" && endpoint.schema && !["main", "temp"].includes(endpoint.schema)) throw new Error("Attached SQLite databases are not supported by this migration workflow");
  return [endpoint.schema, endpoint.table]
    .filter(Boolean)
    .map((name) => identifier(name, endpoint.dialect))
    .join(".");
}
export function isMigrationSqlType(type?: DatabaseType): type is MigrationSqlType {
  return MONGO_MIGRATION_SQL_TYPES.some((entry) => entry === type);
}
export function migrationReadSql(endpoint: MigrationSqlEndpoint, limit: number): string {
  if (!isMigrationSqlType(endpoint.dialect) || !endpoint.table || !Number.isInteger(limit) || limit < 1 || limit > MIGRATION_MAX_ROWS) throw new Error("Invalid SQL endpoint or row limit");
  // Fetch one extra row to distinguish a bounded subset from a complete source.
  return endpoint.dialect === "sqlserver" ? `SELECT TOP (${limit + 1}) * FROM ${tableName(endpoint)};` : `SELECT * FROM ${tableName(endpoint)} LIMIT ${limit + 1};`;
}
export function validateMigrationMappings(value: unknown, direction: MigrationDirection): MongoMigrationMapping[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("Use between 1 and 100 field mappings");
  const targets: string[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.source !== "string" || typeof item.target !== "string" || !item.source || !item.target || !types.has(String(item.type)) || !["reject", "json", "first"].includes(String(item.array)) || !["error", "null", "omit"].includes(String(item.missing)))
      throw new Error("Invalid field mapping");
    if (direction === "mongoToSql") pathParts(item.source);
    else pathParts(item.target);
    if (targets.some((target) => target === item.target || (direction === "sqlToMongo" && (target.startsWith(item.target + ".") || String(item.target).startsWith(target + "."))))) throw new Error(`Overlapping target: ${item.target}`);
    targets.push(item.target);
    if (direction === "mongoToSql" && !["auto", "string", "ejson"].includes(String(item.type))) throw new Error("Mongo to SQL supports auto scalar, string, or EJSON mappings");
  }
  return value as MongoMigrationMapping[];
}
function validateValue(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error("Document nesting exceeds 64 levels");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("Unsafe numeric value: read BIGINT/DECIMAL as text or canonical Extended JSON");
  if (record(value) || Array.isArray(value))
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error("Unsafe document key");
      validateValue(child, depth + 1);
    }
}
export function migrationCheckSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MIGRATION_MAX_BYTES) throw new Error("Migration snapshot/commands exceed 8 MiB; reduce the row limit");
}
export function parseMigrationExtendedJson(text: string): unknown {
  // Validate numeric tokens before JSON.parse can round them. Strings are opaque.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (match[1]) {
      if (!/^-?\d+$/.test(match[1])) throw new Error("Use canonical $numberDouble/$numberDecimal strings for fractional EJSON numbers");
      validateValue(Number(match[1]));
    }
  }
  const value: unknown = JSON.parse(text);
  validateValue(value);
  return value;
}
function integerText(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) throw new Error("Expected an exact integer string");
  return value;
}
function decimalText(value: unknown): string {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error("Expected an exact decimal string, not a floating-point number");
  return value;
}
function decimal128(value: unknown) {
  const text = decimalText(value);
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const digits = mantissa!.replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "");
  const scale = (mantissa!.split(".")[1] ?? "").length;
  const adjusted = Number(exponent) - scale;
  if (digits.length > 34 || !Number.isSafeInteger(adjusted) || adjusted < -6176 || adjusted + Math.max(digits.length, 1) - 1 > 6144) throw new Error("Decimal exceeds lossless Decimal128 range; map to string instead");
  return { $numberDecimal: text };
}
function toMongo(value: unknown, type: MigrationValueType, sourceType = ""): unknown {
  if (value === null) return null;
  validateValue(value);
  if (typeof value === "number" && /^(?:decimal|numeric|number|money)/i.test(sourceType)) throw new Error("Exact SQL decimal arrived as a floating-point number; read it as text before migration");
  if (type === "auto") {
    if (/^(?:decimal|numeric|number|money)/i.test(sourceType)) return decimal128(value);
    if (/^(?:bigint|int8)/i.test(sourceType)) return toMongo(value, "int64");
    return value;
  }
  if (type === "string") {
    if (typeof value === "object") throw new Error("Use EJSON for complex values");
    return String(value);
  }
  if (type === "ejson") {
    if (typeof value !== "string") throw new Error("EJSON mapping requires a SQL text value");
    return parseMigrationExtendedJson(value);
  }
  if (type === "int64") {
    const text = integerText(value);
    const integer = BigInt(text);
    if (integer < -9223372036854775808n || integer > 9223372036854775807n) throw new Error("Integer exceeds BSON int64");
    return { $numberLong: text };
  }
  if (type === "decimal128") return decimal128(value);
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "true") return true;
    if (value === 0 || value === "false") return false;
    throw new Error("Expected true, false, 1, or 0");
  }
  if (type === "objectId") {
    if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) throw new Error("Expected a 24-character ObjectId");
    return { $oid: value };
  }
  // Require explicit timezone and millisecond-or-less precision; never silently round microseconds.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Date requires ISO-8601 timezone and at most millisecond precision; otherwise use string");
  return { $date: value };
}
function setPath(output: Record<string, unknown>, path: string, value: unknown) {
  const parts = pathParts(path);
  let parent = output;
  for (const part of parts.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(parent, part)) parent[part] = {};
    if (!record(parent[part])) throw new Error("Overlapping destination paths");
    parent = parent[part] as Record<string, unknown>;
  }
  parent[parts[parts.length - 1]!] = value;
}
export function sqlRowsToMongo(result: Pick<QueryResult, "columns" | "rows" | "column_types" | "large_value_cells" | "execution_error">, mappings: MongoMigrationMapping[]): Record<string, unknown>[] {
  validateMigrationMappings(mappings, "sqlToMongo");
  if (result.execution_error || result.large_value_cells?.length) throw new Error("Source query failed or contains truncated cells");
  if (result.rows.length > MIGRATION_MAX_ROWS || new Set(result.columns).size !== result.columns.length) throw new Error("Source has too many rows or duplicate column names");
  const indexes = mappings.map((mapping) => {
    const index = result.columns.indexOf(mapping.source);
    if (index < 0) throw new Error(`Missing SQL column: ${mapping.source}`);
    return index;
  });
  const docs = result.rows.map((row, rowIndex) => {
    const doc: Record<string, unknown> = {};
    try {
      mappings.forEach((mapping, index) => {
        const column = indexes[index]!;
        if (column >= row.length) throw new Error("Missing cell");
        setPath(doc, mapping.target, toMongo(row[column], mapping.type, result.column_types?.[column]));
      });
    } catch (cause) {
      throw new Error(`Row ${rowIndex + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return doc;
  });
  migrationCheckSize(docs);
  return docs;
}
function atPath(value: unknown, path: string): unknown {
  for (const part of pathParts(path)) {
    if (!record(value) || scalar(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
export function mongoRowsToSql(documents: unknown[], mappings: MongoMigrationMapping[]): Record<string, unknown>[] {
  validateMigrationMappings(mappings, "mongoToSql");
  if (documents.length > MIGRATION_MAX_ROWS) throw new Error("Too many documents");
  const rows = documents.map((document, rowIndex) => {
    validateValue(document);
    if (!record(document)) throw new Error("Expected canonical Extended JSON documents");
    const row: Record<string, unknown> = Object.create(null);
    for (const mapping of mappings) {
      let value = atPath(document, mapping.source);
      let encodedArray = false;
      if (value === undefined) {
        if (mapping.missing === "error") throw new Error(`Row ${rowIndex + 1}: missing ${mapping.source}`);
        if (mapping.missing === "omit") continue;
        row[mapping.target] = null;
        continue;
      }
      if (Array.isArray(value)) {
        if (mapping.array === "reject") throw new Error(`Array at ${mapping.source}: choose EJSON or explicit first element`);
        if (mapping.array === "first") value = value[0] ?? null;
        else {
          value = JSON.stringify(value);
          encodedArray = true;
        }
      }
      if (mapping.type === "ejson" && !encodedArray) value = JSON.stringify(value);
      else if (mapping.type === "string" && value !== null) {
        if (record(value)) {
          const keys = Object.keys(value);
          if (keys.length === 1 && ["$oid", "$numberLong", "$numberInt", "$numberDecimal", "$numberDouble"].includes(keys[0]!)) value = value[keys[0]!];
          else throw new Error("Use EJSON for date, binary, or complex BSON values");
        }
        if (typeof value === "object") throw new Error("Use EJSON for complex values");
        value = String(value);
      } else if (record(value) && !scalar(value)) throw new Error(`Nested object at ${mapping.source}: map leaf fields or EJSON`);
      row[mapping.target] = value;
    }
    return row;
  });
  migrationCheckSize(rows);
  return rows;
}
function sqlText(value: string, dialect: MigrationSqlType): string {
  if (value.includes("\0")) throw new Error("SQL text containing NUL is not supported; use EJSON");
  if (dialect === "sqlserver") return `N'${value.replaceAll("'", "''")}'`;
  // Hex text avoids backslash/string-literal SQL mode differences.
  const hex = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (dialect === "postgres") return `convert_from(decode('${hex}', 'hex'), 'UTF8')`;
  if (dialect === "mysql") return hex ? `CONVERT(0x${hex} USING utf8mb4)` : "''";
  return `CAST(X'${hex}' AS TEXT)`;
}
function sqlLiteral(value: unknown, column: ColumnInfo, dialect: MigrationSqlType): string {
  if (value === null) {
    if (!column.is_nullable) throw new Error(`Column ${column.name} is not nullable`);
    return "NULL";
  }
  const type = column.data_type.toLowerCase().trim();
  if (/^(?:text|ntext|(?:n?varchar|n?char|character)(?:\b|\())/.test(type) || /^(?:tinytext|mediumtext|longtext)$/.test(type)) {
    if (dialect === "sqlserver" && !/^(?:nvarchar|nchar|ntext)/.test(type)) throw new Error("SQL Server text targets must use Unicode NVARCHAR/NCHAR/NTEXT to avoid code-page loss");
    if (dialect === "mysql" && column.character_set && !/^utf8(?:mb[34])?$/i.test(column.character_set)) throw new Error("MySQL text target must use UTF-8 character set");
    if (typeof value !== "string") throw new Error(`Column ${column.name}: use string or EJSON mapping`);
    const limit = column.character_maximum_length ?? Number(type.match(/\((\d+)\)/)?.[1] ?? 0);
    if (limit > 0 && (dialect === "sqlserver" ? value.length : [...value].length) > limit) throw new Error(`Column ${column.name}: text exceeds target length`);
    return sqlText(value, dialect);
  }
  if (/^(?:bool|boolean|bit)$/.test(type)) {
    if (typeof value !== "boolean") throw new Error(`Column ${column.name}: boolean required`);
    return dialect === "postgres" ? String(value).toUpperCase() : value ? "1" : "0";
  }
  if (/^(?:smallint|int2|integer|int|int4|bigint|int8|tinyint|mediumint)(?:\b|\()/.test(type)) {
    if (record(value) && Object.keys(value).length === 1) value = value.$numberLong ?? value.$numberInt;
    const text = integerText(value);
    const number = BigInt(text);
    const bits = /^(?:bigint|int8)/.test(type) || dialect === "sqlite" ? 64n : /^(?:smallint|int2)/.test(type) ? 16n : type.startsWith("tinyint") ? 8n : type.startsWith("mediumint") ? 24n : 32n;
    const unsigned = /\bunsigned\b/.test(type) || (dialect === "sqlserver" && type.startsWith("tinyint"));
    if (number < (unsigned ? 0n : -(2n ** (bits - 1n))) || number > 2n ** (unsigned ? bits : bits - 1n) - 1n) throw new Error(`Column ${column.name}: integer out of range`);
    return text;
  }
  if (/^(?:decimal|numeric)(?:\b|\()/.test(type) && dialect !== "sqlite") {
    if (record(value) && Object.keys(value).length === 1) value = value.$numberDecimal ?? value.$numberLong ?? value.$numberInt;
    if (typeof value === "number") throw new Error("Use exact BSON Decimal128/int64 or decimal strings for NUMERIC");
    const text = decimalText(value);
    // Require plain notation and known scale to prove no server-side rounding.
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw new Error("NUMERIC migration requires plain decimal notation; use EJSON text for exponents");
    const declared = type.match(/\((\d+)\s*,\s*(\d+)\)/);
    const precision = column.numeric_precision ?? (declared ? Number(declared[1]) : null);
    const scale = column.numeric_scale ?? (declared ? Number(declared[2]) : null);
    if (precision === null || scale === null) throw new Error(`Column ${column.name}: exact precision/scale metadata required; use text`);
    const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
    if (whole!.replace(/^0+/, "").length > precision - scale || fraction.length > scale) throw new Error(`Column ${column.name}: value exceeds precision/scale`);
    return text;
  }
  throw new Error(`Unsupported target type ${column.data_type}: use an existing text/boolean/integer/NUMERIC column and an explicit mapping`);
}
export function migrationSqlOperations(rows: Record<string, unknown>[], endpoint: MigrationSqlEndpoint, columns: ColumnInfo[]): MigrationOperation[] {
  if (!isMigrationSqlType(endpoint.dialect) || !endpoint.table) throw new Error("Unsupported SQL endpoint");
  if (rows.length > MIGRATION_MAX_ROWS) throw new Error("Too many rows");
  const byName = new Map(columns.map((column) => [column.name, column]));
  const operations = rows.map((row) => {
    const keys = Object.keys(row);
    if (!keys.length) throw new Error("No mapped values in row");
    const literals = keys.map((key) => {
      const column = byName.get(key);
      if (!column) throw new Error(`Target column not found: ${key}`);
      if (/auto_increment|generated|identity|computed/i.test(column.extra ?? "")) throw new Error(`Do not map generated column: ${key}`);
      return sqlLiteral(row[key], column, endpoint.dialect);
    });
    return {
      kind: "sql" as const,
      text: `INSERT INTO ${tableName(endpoint)} (${keys.map((key) => identifier(key, endpoint.dialect)).join(", ")}) VALUES (${literals.join(", ")});`,
    };
  });
  migrationCheckSize(operations);
  return operations;
}
export function migrationMongoOperations(documents: Record<string, unknown>[], collection: string): MigrationOperation[] {
  if (documents.length > MIGRATION_MAX_ROWS) throw new Error("Too many documents");
  documents.forEach((document) => validateValue(document));
  validateMongoOutputName(collection, "collection");
  const operations = documents.map((document) => ({
    kind: "mongo" as const,
    text: JSON.stringify({ insert: collection, documents: [document], ordered: true, writeConcern: { w: "majority" } }),
  }));
  migrationCheckSize(operations);
  return operations;
}

export interface MigrationExecutionReport {
  completed: number;
  total: number;
  status: "completed" | "cancelled" | "failed";
  uncertainIndex?: number;
  error?: string;
}
/** Stop between writes only; an in-flight failure is not rolled back and must never be auto-retried. */
export async function executeMigrationOperations(operations: readonly MigrationOperation[], execute: (operation: MigrationOperation) => Promise<void>, options: { signal?: AbortSignal; beforeWrite?: () => void; onProgress?: (completed: number) => void } = {}): Promise<MigrationExecutionReport> {
  let completed = 0;
  for (const operation of operations) {
    if (options.signal?.aborted) return { completed, total: operations.length, status: "cancelled" };
    try {
      options.beforeWrite?.();
    } catch (cause) {
      return { completed, total: operations.length, status: "failed", error: String(cause) };
    }
    try {
      await execute(operation);
      completed++;
      options.onProgress?.(completed);
    } catch (cause) {
      return { completed, total: operations.length, status: "failed", uncertainIndex: completed + 1, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return { completed, total: operations.length, status: "completed" };
}
export function assertMigrationMongoAck(response: unknown): void {
  const number = (value: unknown) => (record(value) ? Number(value.$numberInt ?? value.$numberLong ?? value.$numberDouble) : Number(value));
  if (!record(response) || number(response.ok) !== 1 || number(response.n) !== 1 || (Array.isArray(response.writeErrors) && response.writeErrors.length) || response.writeConcernError) throw new Error(`MongoDB write not acknowledged: ${JSON.stringify(response)}`);
}
