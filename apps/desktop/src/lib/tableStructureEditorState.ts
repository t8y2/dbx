import type { ColumnInfo, DatabaseType, IndexInfo } from "../types/database.ts";
import type { ColumnExtra, EditableStructureColumn, EditableStructureIndex } from "./tableStructureEditorSql.ts";

export const DATA_TYPE_OPTIONS: Record<string, string[]> = {
  mysql: [
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "float",
    "double",
    "double precision",
    "real",
    "decimal",
    "numeric",
    "bit",
    "boolean",
    "bool",
    "serial",
    "char",
    "varchar",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "binary",
    "varbinary",
    "tinyblob",
    "blob",
    "mediumblob",
    "longblob",
    "enum",
    "set",
    "date",
    "datetime",
    "timestamp",
    "time",
    "year",
    "json",
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
  ],
  postgres: [
    "smallint",
    "int2",
    "integer",
    "int",
    "int4",
    "bigint",
    "int8",
    "smallserial",
    "serial",
    "bigserial",
    "decimal",
    "numeric",
    "real",
    "float",
    "float4",
    "double precision",
    "float8",
    "money",
    "boolean",
    "bool",
    "char",
    "character",
    "varchar",
    "character varying",
    "text",
    "bytea",
    "date",
    "time",
    "time without time zone",
    "time with time zone",
    "timetz",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
    "timestamptz",
    "interval",
    "uuid",
    "json",
    "jsonb",
    "xml",
    "bit",
    "bit varying",
    "varbit",
    "tsvector",
    "tsquery",
    "cidr",
    "inet",
    "macaddr",
    "macaddr8",
    "point",
    "line",
    "lseg",
    "box",
    "path",
    "polygon",
    "circle",
    "int4range",
    "int8range",
    "numrange",
    "tsrange",
    "tstzrange",
    "daterange",
    "oid",
  ],
  sqlite: ["integer", "real", "text", "blob", "numeric"],
  rqlite: ["integer", "real", "text", "blob", "numeric"],
  turso: ["integer", "real", "text", "blob", "numeric"],
  sqlserver: [
    "bit",
    "tinyint",
    "smallint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "float",
    "real",
    "money",
    "smallmoney",
    "char",
    "nchar",
    "varchar",
    "nvarchar",
    "text",
    "ntext",
    "date",
    "time",
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
    "timestamp",
    "binary",
    "varbinary",
    "image",
    "uniqueidentifier",
    "xml",
    "sql_variant",
    "hierarchyid",
    "geography",
    "geometry",
  ],
  oracle: [
    "number",
    "integer",
    "float",
    "binary_float",
    "binary_double",
    "char",
    "nchar",
    "varchar2",
    "nvarchar2",
    "clob",
    "nclob",
    "long",
    "date",
    "timestamp",
    "timestamp with time zone",
    "timestamp with local time zone",
    "interval year to month",
    "interval day to second",
    "raw",
    "long raw",
    "blob",
    "bfile",
    "boolean",
    "json",
    "vector",
    "rowid",
    "urowid",
    "xmltype",
    "sdo_geometry",
  ],
  clickhouse: [
    "Int8",
    "Int16",
    "Int32",
    "Int64",
    "Int128",
    "Int256",
    "UInt8",
    "UInt16",
    "UInt32",
    "UInt64",
    "UInt128",
    "UInt256",
    "Float16",
    "Float32",
    "Float64",
    "Decimal",
    "Decimal32",
    "Decimal64",
    "Decimal128",
    "Decimal256",
    "Bool",
    "String",
    "FixedString",
    "Date",
    "Date32",
    "DateTime",
    "DateTime64",
    "UUID",
    "IPv4",
    "IPv6",
    "Enum8",
    "Enum16",
    "Array",
    "Map",
    "Tuple",
    "Nested",
    "Nullable",
    "LowCardinality",
    "SimpleAggregateFunction",
    "AggregateFunction",
    "Point",
    "Ring",
    "Polygon",
    "MultiPolygon",
    "JSON",
  ],
};

const DATA_TYPE_OPTION_ALIASES: Partial<Record<DatabaseType, string>> = {
  doris: "mysql",
  starrocks: "mysql",
  goldendb: "mysql",
  sundb: "mysql",
  gaussdb: "postgres",
  kwdb: "postgres",
  opengauss: "postgres",
  redshift: "postgres",
  highgo: "postgres",
  vastbase: "postgres",
  kingbase: "postgres",
  dameng: "oracle",
  "oceanbase-oracle": "oracle",
  iris: "oracle",
};

export function getDataTypeOptions(dbType: DatabaseType | undefined): string[] {
  const key = dbType ? (DATA_TYPE_OPTION_ALIASES[dbType] ?? dbType) : "";
  return DATA_TYPE_OPTIONS[key] ?? [];
}

export const DEFAULT_TYPE_LENGTHS: Record<string, string> = {
  tinyint: "4",
  smallint: "6",
  mediumint: "9",
  int: "11",
  integer: "11",
  int4: "11",
  bigint: "20",
  int8: "20",
  float: "10,2",
  real: "10,2",
  "double precision": "10,2",
  double: "10,2",
  decimal: "10,0",
  numeric: "10,0",
  number: "10,0",
  char: "1",
  character: "1",
  varchar: "255",
  "character varying": "255",
  varchar2: "255",
  nvarchar2: "255",
  nvarchar: "255",
  nchar: "1",
  varbinary: "255",
  binary: "1",
  bit: "1",
  year: "4",
};

export function parseExtraToColumnExtra(extra: string | null | undefined, databaseType?: DatabaseType): ColumnExtra {
  const result: ColumnExtra = {};
  if (!extra) return result;
  const lower = extra.toLowerCase().trim();
  if (!lower) return result;

  if (databaseType === "mysql") {
    if (lower.includes("auto_increment")) {
      result.autoIncrement = true;
    }
    if (lower.includes("on update current_timestamp")) {
      result.onUpdateCurrentTimestamp = true;
    }
  } else if (databaseType === "postgres" || databaseType === "gaussdb" || databaseType === "kwdb" || databaseType === "opengauss" || databaseType === "highgo" || databaseType === "vastbase" || databaseType === "kingbase") {
    const identityMatch = lower.match(/generated\s+(by\s+default|always)\s+as\s+identity/i);
    if (identityMatch) {
      const sequenceMatch = lower.match(/start\s+with\s*(-?\d+)\s+increment\s+by\s*(-?\d+)/i);
      result.identity = {
        generation: identityMatch[1].toUpperCase() === "BY DEFAULT" ? "BY DEFAULT" : "ALWAYS",
      };
      if (sequenceMatch) {
        result.identity.seed = Number(sequenceMatch[1]);
        result.identity.increment = Number(sequenceMatch[2]);
      }
    }
  } else if (databaseType === "sqlserver") {
    if (lower.includes("identity")) {
      result.autoIncrement = true;
      const identityMatch = lower.match(/identity\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
      if (identityMatch) {
        result.identity = {
          seed: Number(identityMatch[1]),
          increment: Number(identityMatch[2]),
        };
      }
    }
  }

  return result;
}

export function createColumnDrafts(columns: ColumnInfo[], databaseType?: DatabaseType): EditableStructureColumn[] {
  return columns.map((column, index) => ({
    id: `existing:${column.name}`,
    name: column.name,
    dataType: column.data_type,
    isNullable: column.is_nullable,
    defaultValue: column.column_default ?? "",
    comment: column.comment ?? "",
    isPrimaryKey: column.is_primary_key,
    extra: parseExtraToColumnExtra(column.extra, databaseType),
    original: column,
    originalPosition: index,
    markedForDrop: false,
  }));
}

export function createIndexDrafts(indexes: IndexInfo[]): EditableStructureIndex[] {
  return indexes.map((index) => ({
    id: `existing:${index.name}`,
    name: index.name,
    columns: [...index.columns],
    isUnique: index.is_unique,
    isPrimary: index.is_primary,
    filter: index.filter ?? "",
    indexType: index.index_type ?? "",
    includedColumns: index.included_columns ? [...index.included_columns] : [],
    comment: index.comment ?? "",
    original: index,
    markedForDrop: false,
  }));
}

export function toColumnNames(columns: string[]): string {
  return columns.join(", ");
}

export function splitDataType(raw: string): { baseType: string; params: string } {
  const trimmed = raw.trim();
  const parenIdx = trimmed.indexOf("(");
  if (parenIdx === -1) return { baseType: trimmed, params: "" };
  const baseType = trimmed.slice(0, parenIdx).trim();
  const params = trimmed.slice(parenIdx + 1, trimmed.lastIndexOf(")")).trim();
  return { baseType, params };
}

export function combineDataType(baseType: string, params: string): string {
  const type = baseType.trim();
  const p = params.trim();
  if (!type) return "";
  if (!p) return type;
  return `${type}(${p})`;
}

export function combineDataTypeForDatabase(dbType: DatabaseType | undefined, baseType: string, params: string): string {
  return combineDataType(baseType, normalizeDataTypeParams(dbType, baseType, params));
}

export function normalizeDataTypeParams(dbType: DatabaseType | undefined, baseType: string, params: string): string {
  const p = params.trim();
  if (!p) return "";
  if (!isTemporalPrecisionType(dbType, baseType)) return p;
  return isValidTemporalPrecision(dbType, p) ? p : "";
}

function isTemporalPrecisionType(dbType: DatabaseType | undefined, baseType: string): boolean {
  const normalized = baseType.trim().replace(/\s+/g, " ").toLowerCase();
  switch (dbType) {
    case "mysql":
    case "doris":
    case "starrocks":
    case "goldendb":
    case "sundb":
      return ["time", "datetime", "timestamp"].includes(normalized);
    case "postgres":
    case "gaussdb":
    case "kwdb":
    case "opengauss":
    case "highgo":
    case "vastbase":
    case "kingbase":
    case "redshift":
      return ["time", "time without time zone", "time with time zone", "timestamp", "timestamp without time zone", "timestamp with time zone"].includes(normalized);
    case "sqlserver":
      return ["time", "datetime2", "datetimeoffset"].includes(normalized);
    case "oracle":
    case "dameng":
    case "oceanbase-oracle":
      return ["timestamp", "timestamp with time zone", "timestamp with local time zone"].includes(normalized);
    default:
      return false;
  }
}

function isValidTemporalPrecision(dbType: DatabaseType | undefined, params: string): boolean {
  if (!/^\d+$/.test(params)) return false;
  const value = Number(params);
  const max = dbType === "oracle" || dbType === "dameng" || dbType === "oceanbase-oracle" ? 9 : 6;
  return Number.isInteger(value) && value >= 0 && value <= max && String(value) === params;
}

export function getDefaultLengthForType(_dbType: DatabaseType | undefined, baseType: string): string {
  const key = baseType.trim().toLowerCase();
  return DEFAULT_TYPE_LENGTHS[key] ?? "";
}

export function buildStructureTargetLabel(connectionName: string | undefined, database: string | undefined, schema: string | undefined, tableName: string | undefined): string {
  const parts = [connectionName, database];
  if (schema && schema !== database) parts.push(schema);
  if (tableName) parts.push(tableName);
  return parts.filter(Boolean).join(" / ");
}
