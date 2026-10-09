import type { DatabaseType } from "@/types/database";
import { parseBinaryCellBytes } from "@/lib/dataGrid/binaryCellDownload";
import { binaryQueryResultValueHex } from "./queryResultTransfer";
import { normalizeQueryResultColumnType } from "./queryResultTransfer";

/** Database families for which this transfer path can emit a lossless binary literal. */
const SQLITE_TYPES = new Set<DatabaseType>(["sqlite", "rqlite", "turso", "cloudflare-d1"]);
const POSTGRES_TYPES = new Set<DatabaseType>(["postgres", "kingbase", "highgo", "vastbase", "gaussdb", "kwdb", "opengauss"]);
const MYSQL_TYPES = new Set<DatabaseType>(["mysql", "goldendb"]);
// Dameng is registered as a separate driver, but the transfer backend groups
// it with Oracle-family targets (NUMBER booleans and HEXTORAW binary values).
const ORACLE_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "dameng", "yashandb"]);

const BINARY_COLUMN_TYPE_RE = /\b(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bytea|bytes|image|raw|long\s+raw|long\s+varbinary)\b/i;
const BOOLEAN_COLUMN_TYPE_RE = /\b(?:bool|boolean)\b/i;
const INTEGER_COLUMN_TYPE_RE = /^(?:tinyint|smallint|mediumint|int|int2|int4|int8|integer|bigint|serial|bigserial)\b/i;
const EXACT_COLUMN_TYPE_RE = /^(?:decimal|numeric|number|money|smallmoney)\b/i;
const NUMERIC_COLUMN_TYPE_RE = /^(?:tinyint|smallint|mediumint|int|int2|int4|int8|integer|bigint|serial|bigserial|decimal|numeric|number|money|smallmoney|real|double|float|float4|float8|binary_float|binary_double)\b/i;
const NUMERIC_LITERAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizeSourceType(sourceType: string | undefined, databaseType?: DatabaseType): string | undefined {
  if (databaseType === "oracle") {
    // Oracle-go exposes these go-ora wire names; its temporal values retain
    // up to nine fractional digits (main.go::normalizeValue).
    const types: Record<string, string> = {
      timestampdty: "TIMESTAMP(9)",
      timestamptz_dty: "TIMESTAMP(9) WITH TIME ZONE",
    };
    return types[sourceType?.trim().toLowerCase() || ""] || sourceType;
  }
  if (databaseType === "h2") {
    // H2 2.x exposes standard SQL names in ResultSetMetaData, while the
    // transfer helpers use their BLOB/VARBINARY aliases.
    const type = sourceType?.trim();
    if (/^binary varying(?:\s*\(\s*\d+\s*\))?$/i.test(type || "")) return type!.replace(/^binary varying/i, "varbinary");
    if (/^binary large object$/i.test(type || "")) return "BLOB";
    if (/^character large object$/i.test(type || "")) return "CLOB";
    return sourceType;
  }
  if (databaseType !== "sqlserver") return sourceType;
  // Tiberius exposes TDS wire type names for several nullable columns. These
  // names describe values but are not valid CREATE TABLE data types.
  const types: Record<string, string> = {
    int1: "tinyint",
    int2: "smallint",
    int4: "int",
    int8: "bigint",
    intn: "bigint",
    bitn: "bit",
    float4: "real",
    float8: "float",
    floatn: "float",
    decimaln: "decimal",
    numericn: "numeric",
    money4: "smallmoney",
    datetimen: "datetime2(7)",
    datetime4: "smalldatetime",
    daten: "date",
    timen: "time(7)",
    datetimeoffsetn: "datetimeoffset(7)",
    guid: "uniqueidentifier",
  };
  return types[sourceType?.trim().toLowerCase() || ""] || sourceType;
}

function postgresArrayElementType(type: string | undefined, databaseType?: DatabaseType): string | undefined {
  if (!databaseType || !POSTGRES_TYPES.has(databaseType)) return undefined;
  const normalized = type?.trim();
  if (normalized?.endsWith("[]")) return normalized.slice(0, -2);
  // Native PostgreSQL result metadata uses wire names, e.g. _int8 and _text.
  if (normalized?.startsWith("_")) return normalized.slice(1);
  return undefined;
}

/** Only built-in type declarations understood by this transfer path may become SQL. */
function isGenericTypeDeclaration(type: string): boolean {
  const scalar = type.replace(/(?:\[\])+$/, "").trim();
  if (
    /^(?:bool|boolean|real|double precision|binary_float|binary_double|money|smallmoney|date|smalldatetime|serial|smallserial|bigserial|text|ntext|tinytext|mediumtext|longtext|blob|tinyblob|mediumblob|longblob|clob|nclob|bytea|image|uuid|uniqueidentifier|json|jsonb|xml|inet|cidr|macaddr|macaddr8|tsvector|tsquery|geometry|geography|rowversion|enum|set|long raw)$/i.test(
      scalar,
    )
  )
    return true;
  if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|float|float4|float8|double|decimal|numeric|number)(?:\s*\(\s*(?:\d+|\*)\s*(?:,\s*-?\d+\s*)?\))?(?:\s+unsigned)?(?:\s+zerofill)?$/i.test(scalar)) return true;
  if (/^(?:char|varchar|nchar|nvarchar|varchar2|nvarchar2|character|character varying|binary|varbinary|raw|bit|varbit|bit varying|vector)(?:\s*\(\s*(?:\d+|max)\s*(?:char|byte)?\s*\))?$/i.test(scalar)) return true;
  return /^(?:timestamp|timestamptz|time|timetz|datetime|datetime2|datetimeoffset)(?:\s*\(\s*\d+\s*\))?(?:\s+(?:with(?: local)?|without) time zone)?$/i.test(scalar);
}

function textTargetType(databaseType: DatabaseType): string {
  if (databaseType === "sqlserver") return "nvarchar(max)";
  if (ORACLE_TYPES.has(databaseType) || databaseType === "db2" || databaseType === "h2") return "CLOB";
  if (MYSQL_TYPES.has(databaseType)) return "LONGTEXT";
  return "TEXT";
}

function temporalFractionalPrecision(type: string, databaseType?: DatabaseType): number | undefined {
  if (/^(?:date|smalldatetime)$/i.test(type)) return 0;
  // Native SQL Server results call format_sqlserver_datetime_display, which
  // turns the driver's 1/300-second nanosecond approximation into 3-digit
  // canonical display text (for example .896666666 becomes .897).
  if (databaseType === "sqlserver" && /^datetime$/i.test(type)) return 3;
  const temporal = type.match(/^(?:timestamp|timestamptz|time|timetz|datetime|datetime2|datetimeoffset)(?:\s*\(\s*(\d+)\s*\))?(?:\s+(?:with(?: local)?|without) time zone)?$/i);
  if (!temporal || (databaseType === "sqlserver" && /^timestamp\b/i.test(type))) return undefined;
  if (temporal[1] !== undefined) return Number(temporal[1]);
  // Result headers omit the declaration's precision. Use the engine's upper
  // bound, never the default for a freshly declared bare type.
  if (databaseType && (POSTGRES_TYPES.has(databaseType) || MYSQL_TYPES.has(databaseType))) return 6;
  if (databaseType === "sqlserver") return 7;
  if (databaseType === "oracle" || databaseType === "oceanbase-oracle" || databaseType === "h2") return 9;
  if (databaseType === "db2") return 12;
  return undefined;
}

function timestampTargetType(sourceType: string, databaseType: DatabaseType, sourceDatabaseType?: DatabaseType): string {
  const precision = temporalFractionalPrecision(sourceType, sourceDatabaseType);
  if (precision === undefined) return textTargetType(databaseType);
  // PostgreSQL/MySQL stop at microseconds; SQL Server datetime2 stops at
  // 100 ns. A successful assignment otherwise rounds a 7–9 digit wire value.
  if (MYSQL_TYPES.has(databaseType)) return precision <= 6 ? "DATETIME(6)" : textTargetType(databaseType);
  if (POSTGRES_TYPES.has(databaseType)) return precision <= 6 ? "TIMESTAMP" : textTargetType(databaseType);
  if (databaseType === "sqlserver") return precision <= 7 ? "datetime2(7)" : textTargetType(databaseType);
  if (databaseType === "h2" || ORACLE_TYPES.has(databaseType)) return precision <= 9 ? "TIMESTAMP(9)" : textTargetType(databaseType);
  if (databaseType === "db2") return precision <= 12 ? `TIMESTAMP(${Math.max(6, precision)})` : textTargetType(databaseType);
  return precision <= 6 ? "TIMESTAMP" : textTargetType(databaseType);
}

function exactTargetType(type: string, databaseType: DatabaseType): string {
  if (POSTGRES_TYPES.has(databaseType)) return "NUMERIC";
  const precision = type.match(/^(?:decimal|numeric|number)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i);
  if (precision) {
    const digits = Number(precision[1]);
    const scale = Number(precision[2] || 0);
    const maxPrecision = MYSQL_TYPES.has(databaseType) ? 65 : databaseType === "db2" ? 31 : 38;
    if (!SQLITE_TYPES.has(databaseType) && digits > 0 && digits <= maxPrecision && scale <= digits && (!MYSQL_TYPES.has(databaseType) || scale <= 30)) {
      return `${ORACLE_TYPES.has(databaseType) ? "NUMBER" : "DECIMAL"}(${digits},${scale})`;
    }
  }
  // Result metadata often omits precision and scale. Floating point or a bare
  // DECIMAL (which can default to scale 0) would silently round exact values.
  return textTargetType(databaseType);
}

export function queryResultTransferIsBinaryColumnType(sourceType?: string, sourceDatabaseType?: DatabaseType): boolean {
  sourceType = normalizeSourceType(sourceType, sourceDatabaseType);
  if (postgresArrayElementType(sourceType, sourceDatabaseType)) return false;
  return BINARY_COLUMN_TYPE_RE.test(sourceType || "") || (sourceDatabaseType === "sqlserver" && /\b(?:timestamp|rowversion)\b/i.test(sourceType || ""));
}

export function queryResultTransferIsBooleanColumnType(sourceType?: string): boolean {
  return BOOLEAN_COLUMN_TYPE_RE.test(sourceType || "");
}

/**
 * Map a source column type to the target type used by the generic CREATE TABLE path.
 * Reusing this helper for literals keeps boolean and binary values aligned with the
 * type emitted in the target DDL.
 */
export function queryResultTransferTargetType(sourceType: string | undefined, databaseType: DatabaseType, sourceDatabaseType?: DatabaseType): string {
  sourceType = normalizeSourceType(sourceType, sourceDatabaseType);
  const type = (sourceType || "").trim().toLowerCase();
  const arrayElementType = postgresArrayElementType(type, sourceDatabaseType);
  // A user-defined type name can itself contain valid SQL clauses. Restrict
  // this path to complete built-in type declarations, not a blacklist of SQL.
  if (!isGenericTypeDeclaration(arrayElementType || type)) return textTargetType(databaseType);
  if (arrayElementType) return POSTGRES_TYPES.has(databaseType) ? `${arrayElementType}[]` : textTargetType(databaseType);
  const sourceIsSqlServerBinary = sourceDatabaseType === "sqlserver" && /\b(?:timestamp|rowversion)\b/i.test(type);

  if (sourceIsSqlServerBinary) {
    if (POSTGRES_TYPES.has(databaseType)) return "bytea";
    if (MYSQL_TYPES.has(databaseType)) return "BLOB";
    if (ORACLE_TYPES.has(databaseType)) return "BLOB";
    if (databaseType === "sqlserver") return "varbinary(max)";
    if (databaseType === "db2" || databaseType === "h2") return "BLOB";
    return "BLOB";
  }

  if (EXACT_COLUMN_TYPE_RE.test(type)) {
    if (sourceDatabaseType === databaseType && (POSTGRES_TYPES.has(databaseType) || ORACLE_TYPES.has(databaseType))) return type;
    return exactTargetType(type, databaseType);
  }
  if (/^(?:bit|varbit|bit varying)\b/.test(type) && sourceDatabaseType !== databaseType) {
    if (sourceDatabaseType === "sqlserver") {
      if (SQLITE_TYPES.has(databaseType)) return "INTEGER";
      return ORACLE_TYPES.has(databaseType) ? "NUMBER(1)" : "BOOLEAN";
    }
    if (POSTGRES_TYPES.has(databaseType)) return "BIT VARYING";
    return textTargetType(databaseType);
  }
  if (sourceDatabaseType === databaseType && type) {
    if (/^(?:varchar|char|nvarchar|nchar|varchar2|nvarchar2|character|character varying)$/.test(type)) {
      return ORACLE_TYPES.has(databaseType) && type.startsWith("n") ? "NCLOB" : textTargetType(databaseType);
    }
    if (/^(?:binary|varbinary|raw|long raw)$/.test(type)) {
      if (databaseType === "sqlserver") return "varbinary(max)";
      return MYSQL_TYPES.has(databaseType) ? "LONGBLOB" : "BLOB";
    }
    // MySQL's result headers expose bare types, without lengths or precision.
    // Do not let CREATE TABLE's defaults truncate an otherwise valid result.
    if (MYSQL_TYPES.has(databaseType)) {
      if (/^(?:varchar|char|enum|set)$/.test(type)) return "LONGTEXT";
      if (/^(?:binary|varbinary)$/.test(type)) return "LONGBLOB";
      if (/^(?:datetime|timestamp|time)$/.test(type)) return `${type}(6)`;
      if (type === "bit") return "BIT(64)";
      if (INTEGER_COLUMN_TYPE_RE.test(type) && !/unsigned/.test(type)) return "DECIMAL(20,0)";
    }
    // H2 result headers omit fractional precision. TIME defaults to 0 and
    // TIMESTAMP to 6, even though source values can contain nine digits.
    if (databaseType === "h2") {
      const temporal = type.match(/^(time|timestamp)(\s+(?:with|without) time zone)?$/);
      if (temporal) return `${temporal[1]}(9)${temporal[2] || ""}`;
    }
    if (databaseType === "oracle" || databaseType === "oceanbase-oracle") {
      const temporal = type.match(/^timestamp(\s+with(?: local)? time zone)?$/);
      if (temporal) return `TIMESTAMP(9)${temporal[1] || ""}`;
    }
    if (databaseType === "db2" && /^timestamp$/.test(type)) return "TIMESTAMP(12)";
    if (POSTGRES_TYPES.has(databaseType) && /^(?:bit|varbit|bit varying)$/.test(type)) return "BIT VARYING";
    return normalizeQueryResultColumnType(sourceType!, databaseType);
  }

  if (SQLITE_TYPES.has(databaseType)) {
    if (BOOLEAN_COLUMN_TYPE_RE.test(type)) return "INTEGER";
    if (INTEGER_COLUMN_TYPE_RE.test(type)) return sourceDatabaseType && MYSQL_TYPES.has(sourceDatabaseType) ? "TEXT" : /unsigned/.test(type) ? "TEXT" : "INTEGER";
    if (/real|double|float/.test(type)) return "REAL";
    if (BINARY_COLUMN_TYPE_RE.test(type)) return "BLOB";
    return "TEXT";
  }

  if (BOOLEAN_COLUMN_TYPE_RE.test(type)) {
    if (databaseType === "sqlserver") return "bit";
    if (ORACLE_TYPES.has(databaseType)) return "NUMBER(1)";
    return "BOOLEAN";
  }
  if (INTEGER_COLUMN_TYPE_RE.test(type)) {
    if (/unsigned/.test(type) || (sourceDatabaseType && MYSQL_TYPES.has(sourceDatabaseType))) return ORACLE_TYPES.has(databaseType) ? "NUMBER(20,0)" : "DECIMAL(20,0)";
    if (/bigint|bigserial|int8/.test(type)) return ORACLE_TYPES.has(databaseType) ? "NUMBER(19)" : "BIGINT";
    return ORACLE_TYPES.has(databaseType) ? "NUMBER" : "INTEGER";
  }
  if (/real|double|float/.test(type)) {
    if (databaseType === "sqlserver") return "float";
    if (ORACLE_TYPES.has(databaseType)) return "BINARY_DOUBLE";
    return ["db2", "dameng"].includes(databaseType) ? "DOUBLE" : "DOUBLE PRECISION";
  }
  if (/^date$/.test(type) && !(sourceDatabaseType && ORACLE_TYPES.has(sourceDatabaseType))) return "DATE";
  if (/^(?:time|timetz)\b/.test(type) || /time zone|timestamptz|datetimeoffset/.test(type)) return textTargetType(databaseType);
  if (/date|time|timestamp/.test(type)) {
    return timestampTargetType(type, databaseType, sourceDatabaseType);
  }
  if (/json/.test(type)) {
    if (databaseType === "postgres") return "jsonb";
    if (databaseType === "mysql") return "json";
    if (databaseType === "sqlserver") return "nvarchar(max)";
    return "CLOB";
  }
  if (BINARY_COLUMN_TYPE_RE.test(type) || sourceIsSqlServerBinary) {
    if (POSTGRES_TYPES.has(databaseType)) return "bytea";
    if (MYSQL_TYPES.has(databaseType)) return "BLOB";
    if (ORACLE_TYPES.has(databaseType)) return "BLOB";
    if (databaseType === "sqlserver") return "varbinary(max)";
    if (databaseType === "h2" || databaseType === "db2") return "BLOB";
    return "BLOB";
  }
  return textTargetType(databaseType);
}

function escapedTextLiteral(value: string, databaseType: DatabaseType, targetType?: string): string | undefined {
  const escaped = value.replaceAll("'", "''");
  if (ORACLE_TYPES.has(databaseType)) {
    const encoder = new TextEncoder();
    if (encoder.encode(escaped).length > 4000) {
      // Mirror data_grid_sql.rs::format_oracle_lob_assignment_literal: each
      // literal stays below Oracle 19c's STANDARD limit, and concatenation
      // happens on LOB values instead of overflowing a VARCHAR2 expression.
      if ((databaseType !== "oracle" && databaseType !== "oceanbase-oracle") || !/^(?:n?clob)\b/i.test(targetType || "")) return undefined;
      const constructor = /^nclob\b/i.test(targetType || "") ? "TO_NCLOB" : "TO_CLOB";
      const chunks: string[] = [];
      let chunk = "";
      let byteLength = 0;
      for (const character of value) {
        const escapedCharacter = character === "'" ? "''" : character;
        const length = encoder.encode(escapedCharacter).length;
        if (byteLength + length > 3900) {
          chunks.push(`${constructor}('${chunk}')`);
          chunk = "";
          byteLength = 0;
        }
        chunk += escapedCharacter;
        byteLength += length;
      }
      if (chunk) chunks.push(`${constructor}('${chunk}')`);
      return chunks.join(" || ");
    }
  }
  const isAsciiControl = (character: string) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;
  if (POSTGRES_TYPES.has(databaseType) && Array.from(value).some((character) => character === "\\" || isAsciiControl(character))) {
    // Match dbx-sql-core/value_literals.rs. E strings are independent of
    // standard_conforming_strings, including quotes following a backslash.
    const pgEscaped = Array.from(value, (character) => {
      if (character === "\\") return "\\\\";
      if (character === "'") return "''";
      return isAsciiControl(character) ? `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}` : character;
    }).join("");
    return `E'${pgEscaped}'`;
  }
  if (databaseType === "sqlserver") return `N'${escaped}'`;
  if (MYSQL_TYPES.has(databaseType)) {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  return `'${escaped}'`;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "f" || normalized === "no" || normalized === "0") return false;
  return undefined;
}

function binaryLiteral(value: unknown, databaseType: DatabaseType, targetType: string, sourceType?: string, sourceDatabaseType?: DatabaseType): string | undefined {
  if (!queryResultTransferIsBinaryColumnType(sourceType, sourceDatabaseType)) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const prefixed = trimmed.match(/^(?:0x|\\x)(.*)$/i);
    if (prefixed) {
      const hex = prefixed[1]!.replace(/\s+/g, "");
      // The backend's binary contract is a 0x-prefixed byte string. Do not
      // reinterpret malformed values as the UTF-8 bytes of their display text.
      if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;
    }
  }
  if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value) && !parseBinaryCellBytes(value, "binary")) return undefined;
  const hex = binaryQueryResultValueHex(value);
  if (SQLITE_TYPES.has(databaseType) || databaseType === "h2") return `X'${hex}'`;
  if (POSTGRES_TYPES.has(databaseType)) return `decode('${hex}', 'hex')`;
  if (MYSQL_TYPES.has(databaseType)) return `X'${hex}'`;
  if (databaseType === "sqlserver") return `0x${hex}`;
  if (ORACLE_TYPES.has(databaseType)) return hex.length > 0 ? `HEXTORAW('${hex}')` : /blob/i.test(targetType) ? "EMPTY_BLOB()" : undefined;
  if (databaseType === "db2") return `BX'${hex}'`;
  // Do not silently turn canonical binary values into quoted text for engines
  // whose binary literal syntax is not verified here.
  return undefined;
}

function numericStringLiteral(value: string, sourceType?: string): string | undefined {
  if (!NUMERIC_COLUMN_TYPE_RE.test(sourceType || "")) return undefined;
  const normalized = value.trim();
  return NUMERIC_LITERAL_RE.test(normalized) ? normalized : undefined;
}

function postgresArrayLiteral(value: unknown, databaseType: DatabaseType, elementType: string, sourceDatabaseType: DatabaseType): string | undefined {
  // Text-fallback PostgreSQL results already use the server's array syntax.
  if (typeof value === "string") return escapedTextLiteral(value, databaseType);
  if (!Array.isArray(value) || !/^[a-z][a-z0-9_]*(?:\[\])*$/i.test(elementType)) return undefined;
  const literals = value.map((item) => {
    if (Array.isArray(item) && !/^(?:json|jsonb)$/i.test(elementType)) return postgresArrayLiteral(item, databaseType, elementType, sourceDatabaseType);
    return queryResultTransferSqlLiteral(item, databaseType, elementType, elementType, sourceDatabaseType);
  });
  if (literals.some((literal) => literal === undefined)) return undefined;
  return `ARRAY[${literals.join(", ")}]::${elementType}[]`;
}

function oracleTemporalLiteral(value: string, targetType: string): string | undefined {
  // Explicit masks mirror the backend transfer path and avoid NLS_DATE_FORMAT
  // and NLS_TIMESTAMP_FORMAT changing the meaning of a query result value.
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(?:\s*(Z|[+-]\d{2}:\d{2}))?)?$/i);
  if (!parts) return undefined;
  const [, date, time = "00:00:00", fraction = "", zone] = parts;
  if (/^date$/i.test(targetType.trim())) {
    if (zone || (fraction && !/^\.0+$/.test(fraction))) return undefined;
    if (time === "00:00:00") return `DATE '${date}'`;
    return `TO_DATE('${date} ${time}', 'YYYY-MM-DD HH24:MI:SS')`;
  }
  const mask = `YYYY-MM-DD HH24:MI:SS${fraction ? ".FF" : ""}`;
  if (zone) {
    if (!/with (?:local )?time zone/i.test(targetType)) return undefined;
    const offset = /^z$/i.test(zone) ? "+00:00" : zone;
    return `TO_TIMESTAMP_TZ('${date} ${time}${fraction} ${offset}', '${mask} TZH:TZM')`;
  }
  if (/with (?:local )?time zone/i.test(targetType)) return undefined;
  return `TO_TIMESTAMP('${date} ${time}${fraction}', '${mask}')`;
}

function bitStringLiteral(value: unknown, databaseType: DatabaseType, sourceDatabaseType: DatabaseType | undefined, targetType: string): string | undefined {
  // SQL Server bit is boolean, while PostgreSQL/MySQL bit values are bit strings.
  if (sourceDatabaseType === "sqlserver") {
    const bool = booleanValue(value);
    if (bool === undefined) return undefined;
    if (databaseType === "sqlserver" || ORACLE_TYPES.has(databaseType) || SQLITE_TYPES.has(databaseType)) return bool ? "1" : "0";
    return bool ? "TRUE" : "FALSE";
  }
  const bits = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  if (!/^[01]+$/.test(bits)) return undefined;
  if (/^(?:bit|varbit)/i.test(targetType) && (MYSQL_TYPES.has(databaseType) || POSTGRES_TYPES.has(databaseType))) return `B'${bits}'`;
  return escapedTextLiteral(bits, databaseType, targetType);
}

/**
 * Emit a SQL literal for query-result transfer. `undefined` means the value
 * cannot be represented safely by this path; callers must abort the transfer.
 */
export function queryResultTransferSqlLiteral(value: unknown, databaseType: DatabaseType, sourceType?: string, targetType?: string, sourceDatabaseType?: DatabaseType): string | undefined {
  const sourceIsSqlServerDatetime = sourceDatabaseType === "sqlserver" && /^(?:datetime|datetimen)$/i.test(sourceType?.trim() || "");
  sourceType = normalizeSourceType(sourceType, sourceDatabaseType);
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string" && value.includes("\0") && POSTGRES_TYPES.has(databaseType)) return undefined;
  const effectiveType = (normalizeSourceType(targetType, databaseType) || queryResultTransferTargetType(sourceType, databaseType, sourceDatabaseType)).toLowerCase();
  if (typeof value === "string") {
    const parts = value.trim().match(/^(?:\d{4}-\d{2}-\d{2}[T ])?([+-]?\d{2,3}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*(?:Z|[+-]\d{2}:\d{2}))?$/i);
    const fraction = parts?.[4];
    const precision = SQLITE_TYPES.has(databaseType) ? undefined : temporalFractionalPrecision(effectiveType, databaseType);
    if (fraction && precision !== undefined && /[1-9]/.test(fraction.slice(precision))) return undefined;
    if (parts) {
      // Oracle DATE retains the clock; SQLite DATE has no temporal coercion.
      if (effectiveType === "date" && !ORACLE_TYPES.has(databaseType) && !SQLITE_TYPES.has(databaseType) && parts.slice(1, 4).some((part) => Number(part) !== 0)) return undefined;
      if (databaseType === "sqlserver" && effectiveType === "smalldatetime" && Number(parts[3]) !== 0) return undefined;
      if (databaseType === "sqlserver" && effectiveType === "datetime") {
        const millisecondDigit = (fraction || "").padEnd(3, "0")[2]!;
        // A legacy SQL Server value's canonical .003/.007 display text maps
        // back to the same 1/300-second tick. Other sources are exact decimal
        // times: only 10 ms multiples are exactly representable as ticks.
        if (sourceIsSqlServerDatetime ? !/[037]/.test(millisecondDigit) : millisecondDigit !== "0") return undefined;
      }
    }
  }
  // Unknown user-defined types are serialized as values; their names must not
  // accidentally select boolean, binary or numeric conversion by a substring.
  if (!isGenericTypeDeclaration(postgresArrayElementType(sourceType, sourceDatabaseType) || sourceType || "")) sourceType = undefined;
  if (databaseType === "h2" && /^json\b/.test(effectiveType)) {
    // A character literal assigned to H2 JSON becomes a JSON string. Mark
    // the payload as JSON so objects, arrays and scalars retain their kind.
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `JSON ${escapedTextLiteral(text, databaseType, effectiveType)}`;
  }
  if (value === "" && ORACLE_TYPES.has(databaseType)) return /^(?:n?clob)\b/.test(effectiveType) ? "EMPTY_CLOB()" : undefined;
  const arrayElementType = postgresArrayElementType(sourceType, sourceDatabaseType);
  if (arrayElementType && isGenericTypeDeclaration(arrayElementType) && POSTGRES_TYPES.has(databaseType) && postgresArrayElementType(effectiveType, databaseType)) return postgresArrayLiteral(value, databaseType, arrayElementType, sourceDatabaseType!);
  if (arrayElementType) return escapedTextLiteral(typeof value === "string" ? value : JSON.stringify(value), databaseType, effectiveType);
  if (/^(?:bit|varbit|bit varying)\b/i.test(sourceType || "")) return bitStringLiteral(value, databaseType, sourceDatabaseType, effectiveType);

  const binary = binaryLiteral(value, databaseType, effectiveType, sourceType, sourceDatabaseType);
  if (queryResultTransferIsBinaryColumnType(sourceType, sourceDatabaseType)) return binary;

  const bool = typeof value === "boolean" || queryResultTransferIsBooleanColumnType(sourceType) ? booleanValue(value) : undefined;
  if (bool !== undefined) {
    const numericBooleanTarget = /^(?:number|numeric|decimal|tinyint|smallint|int|integer|bit)\b/.test(effectiveType) || ORACLE_TYPES.has(databaseType) || databaseType === "sqlserver" || SQLITE_TYPES.has(databaseType);
    if (numericBooleanTarget) return bool ? "1" : "0";
    return bool ? "TRUE" : "FALSE";
  }

  if (typeof value === "string" && ORACLE_TYPES.has(databaseType) && /^(?:date|timestamp)\b/.test(effectiveType)) return oracleTemporalLiteral(value, effectiveType);
  if (typeof value === "number" && (INTEGER_COLUMN_TYPE_RE.test(sourceType || "") || EXACT_COLUMN_TYPE_RE.test(sourceType || "")) && Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
  if (/^(?:n?varchar|n?char|text|longtext|mediumtext|n?clob)\b/.test(effectiveType)) {
    return escapedTextLiteral(typeof value === "object" ? JSON.stringify(value) : String(value), databaseType, effectiveType);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const numeric = numericStringLiteral(value, sourceType);
    if (numeric) return numeric;
  }

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return escapedTextLiteral(text, databaseType, effectiveType);
}
