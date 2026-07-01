import type { ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "../types/database.ts";
import type { ColumnExtra, EditableStructureColumn, EditableStructureForeignKey, EditableStructureIndex, EditableStructureTrigger } from "./tableStructureEditorSql.ts";

export const DATA_TYPE_OPTIONS: Record<string, string[]> = {
  mysql: [
    "tinyint",
    "tinyint unsigned",
    "smallint",
    "smallint unsigned",
    "mediumint",
    "mediumint unsigned",
    "int",
    "int unsigned",
    "integer",
    "integer unsigned",
    "bigint",
    "bigint unsigned",
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
  manticoresearch: ["text", "string", "int", "bit", "bigint", "bool", "timestamp", "float", "json", "float_vector", "multi", "mva"],
  informix: [
    "smallint",
    "integer",
    "int",
    "bigint",
    "int8",
    "serial",
    "serial8",
    "bigserial",
    "decimal",
    "numeric",
    "money",
    "smallfloat",
    "float",
    "real",
    "char",
    "varchar",
    "lvarchar",
    "nchar",
    "nvarchar",
    "text",
    "clob",
    "byte",
    "blob",
    "boolean",
    "date",
    "datetime year to second",
    "datetime year to fraction",
    "interval day to second",
  ],
  questdb: ["boolean", "ipv4", "byte", "short", "char", "int", "float", "symbol", "varchar", "string", "long", "date", "timestamp", "timestamp_ns", "double", "uuid", "binary", "long256", "geohash", "array", "interval", "decimal"],
  xugu: ["BOOLEAN", "INTEGER", "SMALLINT", "BIGINT", "FLOAT", "NUMERIC", "CHAR", "VARCHAR", "CLOB", "DATE", "TIME", "TIMESTAMP", "BINARY", "VARBINARY", "BLOB", "XML", "BOOL", "INT", "SHORT", "LONGINT", "LONG", "REAL", "DECIMAL", "TEXT", "NCHAR", "NVARCHAR", "NVARCHAR2"],
};

const DATA_TYPE_OPTION_ALIASES: Partial<Record<DatabaseType, string>> = {
  doris: "mysql",
  starrocks: "mysql",
  goldendb: "mysql",
  sundb: "mysql",
  oscar: "oracle",
  gbase: "mysql",
  gaussdb: "postgres",
  kwdb: "postgres",
  opengauss: "postgres",
  questdb: "questdb",
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

export interface ColumnEditorControls {
  length: boolean;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: boolean;
  comment: boolean;
}

const DEFAULT_COLUMN_EDITOR_CONTROLS: ColumnEditorControls = {
  length: true,
  nullable: true,
  primaryKey: true,
  defaultValue: true,
  comment: true,
};

export function getColumnEditorControls(dbType: DatabaseType | undefined): ColumnEditorControls {
  if (dbType === "manticoresearch") {
    return {
      length: true,
      nullable: false,
      primaryKey: false,
      defaultValue: false,
      comment: false,
    };
  }
  return DEFAULT_COLUMN_EDITOR_CONTROLS;
}

export function isProtectedManticoreIdColumn(dbType: DatabaseType | undefined, columnName: string): boolean {
  return dbType === "manticoresearch" && columnName.trim().toLowerCase() === "id";
}

export function canEditManticoreColumnProperties(dbType: DatabaseType | undefined, hasOriginalColumn: boolean): boolean {
  return dbType === "manticoresearch" && !hasOriginalColumn;
}

export const DEFAULT_TYPE_LENGTHS: Record<string, string> = {
  tinyint: "4",
  "tinyint unsigned": "4",
  smallint: "6",
  "smallint unsigned": "6",
  mediumint: "9",
  "mediumint unsigned": "9",
  int: "11",
  "int unsigned": "11",
  integer: "11",
  "integer unsigned": "11",
  int4: "11",
  bigint: "20",
  "bigint unsigned": "20",
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

export const QUESTDB_TYPE_LENGTHS: Record<string, string> = {
  geohash: "8c",
  decimal: "10,2",
};

export const DEFAULT_TYPE_LENGTH_DISABLES: string[] = [];

export const POSTGRES_TYPE_LENGTH_DISABLES: string[] = [
  "bigint",
  "int8",
  "bigserial",
  "serial8",
  "boolean",
  "bool",
  "box",
  "bytea",
  "cidr",
  "circle",
  "date",
  "double precision",
  "float",
  "float8",
  "inet",
  "integer",
  "int",
  "int4",
  "json",
  "jsonb",
  "line",
  "lseg",
  "macaddr",
  "macaddr8",
  "money",
  "path",
  "pg_lsn",
  "pg_snapshot",
  "point",
  "polygon",
  "real",
  "float4",
  "smallint",
  "int2",
  "smallserial",
  "serial2",
  "serial",
  "serial4",
  "text",
  "tsquery",
  "tsvector",
  "txid_snapshot",
  "uuid",
  "xml",
];

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
  } else if (databaseType === "postgres" || databaseType === "gaussdb" || databaseType === "kwdb" || databaseType === "opengauss" || databaseType === "questdb" || databaseType === "highgo" || databaseType === "vastbase" || databaseType === "kingbase") {
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
  } else if (databaseType === "manticoresearch") {
    const tokens = new Set(lower.split(/\s+/).filter(Boolean));
    if (tokens.has("indexed")) result.manticoreIndexed = true;
    if (tokens.has("stored")) result.manticoreStored = true;
    if (tokens.has("attribute")) result.manticoreAttribute = true;
    if (/secondary_index\s*=\s*['"]?1['"]?/.test(lower)) result.manticoreSecondaryIndex = true;
  }

  return result;
}

const MANTICORE_COLUMN_PROPERTY_TOKENS = new Set(["indexed", "stored", "attribute"]);

function splitManticoreDdlColumnLine(line: string): { name: string; dataType: string; extra: string } | null {
  const trimmed = line.trim().replace(/,$/, "").trim();
  if (!trimmed || trimmed.startsWith(")") || trimmed.startsWith("(")) return null;

  let name = "";
  let rest = "";
  const quoted = trimmed.match(/^`((?:``|[^`])+)`\s+(.+)$/);
  if (quoted) {
    name = quoted[1]!.replace(/``/g, "`");
    rest = quoted[2]!.trim();
  } else {
    const plain = trimmed.match(/^([A-Za-z_][\w$]*)\s+(.+)$/);
    if (!plain) return null;
    name = plain[1]!;
    rest = plain[2]!.trim();
  }

  const parts = rest.split(/\s+/).filter(Boolean);
  const dataType = parts.shift() ?? "";
  const properties = parts.filter((part) => {
    const normalized = part.toLowerCase();
    return MANTICORE_COLUMN_PROPERTY_TOKENS.has(normalized) || /^secondary_index\s*=/.test(normalized);
  });
  if (!name || !dataType || properties.length === 0) return null;

  return { name, dataType, extra: properties.join(" ") };
}

export function applyManticoreDdlColumnExtras(columns: ColumnInfo[], ddl: string): ColumnInfo[] {
  if (!ddl.trim()) return columns;
  const extrasByColumn = new Map<string, { dataType: string; extra: string }>();
  for (const line of ddl.split(/\r?\n/)) {
    const parsed = splitManticoreDdlColumnLine(line);
    if (parsed) extrasByColumn.set(parsed.name.toLowerCase(), { dataType: parsed.dataType, extra: parsed.extra });
  }
  if (extrasByColumn.size === 0) return columns;

  return columns.map((column) => {
    const ddlColumn = extrasByColumn.get(column.name.toLowerCase());
    if (!ddlColumn) return column;
    const existingExtra = column.extra?.trim();
    return {
      ...column,
      data_type: ddlColumn.dataType || column.data_type,
      extra: existingExtra ? `${existingExtra} ${ddlColumn.extra}` : ddlColumn.extra,
    };
  });
}

function isPostgresTextualType(dataType: string): boolean {
  const baseType = dataType.split("(")[0]?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  return ["char", "character", "varchar", "character varying", "text", "bpchar", "name", "json", "jsonb", "xml", "bytea", "uuid"].includes(baseType);
}

function stripPostgresStringDefaultCast(defaultValue: string, dataType: string): string {
  if (!isPostgresTextualType(dataType)) return defaultValue;
  const trimmed = defaultValue.trim();
  const match = trimmed.match(/^('(?:''|[^'])*')::\s*((?:character\s+varying)|character|varchar|char|text|bpchar|name|jsonb?|xml|bytea|uuid)(?:\s*\(\s*\d+\s*\))?$/i);
  return match?.[1] ?? defaultValue;
}

function isWrappedByOuterParens(value: string): boolean {
  if (value.length < 2 || value[0] !== "(" || value[value.length - 1] !== ")") return false;

  let depth = 0;
  let inString = false;
  let inBracketIdentifier = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (char === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }
    if (inBracketIdentifier) {
      if (char === "]") inBracketIdentifier = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      continue;
    }
    if (char === "[") {
      inBracketIdentifier = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
      if (depth === 0 && index < value.length - 1) return false;
    }
  }
  return depth === 0;
}

function stripSqlServerDefaultOuterParens(defaultValue: string): string {
  let value = defaultValue.trim();
  while (isWrappedByOuterParens(value)) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function columnDefaultForEditor(column: ColumnInfo, databaseType?: DatabaseType): string {
  const defaultValue = column.column_default ?? "";
  if (databaseType === "postgres") return stripPostgresStringDefaultCast(defaultValue, column.data_type);
  if (databaseType === "sqlserver") return stripSqlServerDefaultOuterParens(defaultValue);
  return defaultValue;
}

export function createColumnDrafts(columns: ColumnInfo[], databaseType?: DatabaseType): EditableStructureColumn[] {
  return columns.map((column, index) => {
    const defaultValue = columnDefaultForEditor(column, databaseType);
    return {
      id: `existing:${column.name}`,
      name: column.name,
      dataType: column.data_type,
      isNullable: column.is_nullable,
      defaultValue,
      comment: column.comment ?? "",
      isPrimaryKey: column.is_primary_key,
      extra: parseExtraToColumnExtra(column.extra, databaseType),
      original: { ...column, column_default: column.column_default === null ? null : defaultValue },
      originalPosition: index,
      markedForDrop: false,
    };
  });
}

function existingColumnIdName(id: string): string | undefined {
  const prefix = "existing:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

function isNewColumnDraftId(id: string): boolean {
  return id.startsWith("new:");
}

function uniqueNames(names: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function findColumnDraftByName(columns: EditableStructureColumn[], names: string[], usedIndexes: Set<number>): number | undefined {
  for (const name of names) {
    const exactIndex = columns.findIndex((column, index) => !usedIndexes.has(index) && column.name === name);
    if (exactIndex >= 0) return exactIndex;
  }

  for (const name of names) {
    const lowerName = name.toLowerCase();
    const matches = columns.map((column, index) => ({ column, index })).filter(({ column, index }) => !usedIndexes.has(index) && column.name.toLowerCase() === lowerName);
    if (matches.length === 1) return matches[0]!.index;
  }

  return undefined;
}

export function rehydrateColumnDraftsFromMetadata(draftColumns: EditableStructureColumn[], columns: ColumnInfo[], databaseType?: DatabaseType): EditableStructureColumn[] {
  const metadataDrafts = createColumnDrafts(columns, databaseType);
  if (!metadataDrafts.length) return draftColumns;
  if (!draftColumns.length) return metadataDrafts;

  const usedMetadataIndexes = new Set<number>();
  const nextColumns = draftColumns.map((column) => {
    if (!column.original && isNewColumnDraftId(column.id)) return column;

    const needsHydration = !column.original || column.originalPosition === undefined;
    const candidates = uniqueNames([column.original?.name, existingColumnIdName(column.id), column.name]);
    const metadataIndex = findColumnDraftByName(metadataDrafts, candidates, usedMetadataIndexes);
    if (metadataIndex === undefined) return column;
    usedMetadataIndexes.add(metadataIndex);
    if (!needsHydration) return column;

    const metadataDraft = metadataDrafts[metadataIndex]!;
    return {
      ...column,
      original: column.original ?? metadataDraft.original,
      originalPosition: column.originalPosition ?? metadataDraft.originalPosition,
    };
  });

  if (usedMetadataIndexes.size === 0) {
    return [...metadataDrafts, ...draftColumns];
  }

  const missingMetadataDrafts = metadataDrafts.filter((_, index) => !usedMetadataIndexes.has(index));
  return [...nextColumns, ...missingMetadataDrafts];
}

export function createIndexDrafts(indexes: IndexInfo[]): EditableStructureIndex[] {
  return indexes.map((index) => ({
    id: `existing:${index.name}`,
    name: index.name,
    columns: [...index.columns],
    nameEdited: true,
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

export function createForeignKeyDrafts(foreignKeys: ForeignKeyInfo[]): EditableStructureForeignKey[] {
  const groups = new Map<string, ForeignKeyInfo[]>();
  for (const foreignKey of foreignKeys) {
    const key = [foreignKey.name, foreignKey.ref_schema ?? "", foreignKey.ref_table, foreignKey.on_update ?? "", foreignKey.on_delete ?? ""].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), foreignKey]);
  }

  return [...groups.values()].map((group, index) => {
    const first = group[0]!;
    const original = {
      ...first,
      column: group.map((foreignKey) => foreignKey.column).join(", "),
      ref_column: group.map((foreignKey) => foreignKey.ref_column).join(", "),
    };
    return {
      id: `existing:${first.name}:${index}`,
      name: first.name,
      column: original.column,
      refSchema: first.ref_schema ?? "",
      refTable: first.ref_table,
      refColumn: original.ref_column,
      onUpdate: first.on_update ?? "",
      onDelete: first.on_delete ?? "",
      original,
      markedForDrop: false,
    };
  });
}

export function createTriggerDrafts(triggers: TriggerInfo[]): EditableStructureTrigger[] {
  return triggers.map((trigger) => ({
    id: `existing:${trigger.name}`,
    name: trigger.name,
    timing: trigger.timing,
    event: trigger.event,
    statement: trigger.statement ?? "",
    original: trigger,
    markedForDrop: false,
  }));
}

export function toColumnNames(columns: string[]): string {
  return columns.join(", ");
}

const AUTO_INDEX_NAME_MAX_LENGTH = 63;

function normalizeIndexNamePart(value: string): string {
  const trimmed = value.trim();
  const unquoted = (trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed;
  return unquoted
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function truncateIndexName(value: string, maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  const suffix = "_IDX";
  if (!value.endsWith(suffix)) return value.slice(0, maxLength).replace(/_+$/g, "");
  return `${value.slice(0, maxLength - suffix.length).replace(/_+$/g, "")}${suffix}`;
}

export function generateIndexName(tableName: string, columns: string[], maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  const parts = [tableName, ...columns].map(normalizeIndexNamePart).filter(Boolean);
  if (parts.length === 0) return "";
  return truncateIndexName(`${parts.join("_")}_IDX`, maxLength);
}

export function generateUniqueIndexName(tableName: string, columns: string[], existingNames: Iterable<string>, maxLength = AUTO_INDEX_NAME_MAX_LENGTH): string {
  const base = generateIndexName(tableName, columns, maxLength);
  if (!base) return "";

  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;

  for (let counter = 2; counter < 10_000; counter++) {
    const suffix = `_${counter}`;
    const stem = base.length + suffix.length <= maxLength ? base : base.slice(0, maxLength - suffix.length).replace(/_+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export function splitDataType(raw: string): { baseType: string; params: string } {
  const trimmed = raw.trim();
  const parenIdx = trimmed.indexOf("(");
  if (parenIdx === -1) return { baseType: trimmed, params: "" };
  const closeIdx = trimmed.lastIndexOf(")");
  const baseTypePrefix = trimmed.slice(0, parenIdx).trim();
  const params = trimmed.slice(parenIdx + 1, closeIdx).trim();
  const suffix = trimmed
    .slice(closeIdx + 1)
    .trim()
    .replace(/\s+/g, " ");
  const baseType = /^(?:signed|unsigned|zerofill)(?:\s+(?:signed|unsigned|zerofill))*$/i.test(suffix) ? `${baseTypePrefix} ${suffix}`.trim() : baseTypePrefix;
  return { baseType, params };
}

export function isSqlServerIdentityCompatibleDataType(rawDataType: string): boolean {
  const { baseType, params } = splitDataType(rawDataType);
  const normalized = baseType.trim().replace(/\s+/g, " ").toLowerCase();
  if (["tinyint", "smallint", "int", "integer", "bigint"].includes(normalized)) return true;
  if (normalized !== "decimal" && normalized !== "numeric") return false;
  const normalizedParams = params.replace(/\s+/g, "");
  if (!normalizedParams) return true;
  const parts = normalizedParams.split(",");
  if (parts.length === 1) return /^\d+$/.test(parts[0] ?? "");
  if (parts.length !== 2) return false;
  const [precision, scale] = parts;
  return /^\d+$/.test(precision ?? "") && scale === "0";
}

export function combineDataType(baseType: string, params: string): string {
  const type = baseType.trim();
  const p = params.trim();
  if (!type) return "";
  if (!p) return type;
  return `${type}(${p})`;
}

export function combineDataTypeForDatabase(dbType: DatabaseType | undefined, baseType: string, params: string): string {
  if (isDataTypeLengthDisabled(dbType, baseType)) {
    return baseType;
  }
  const normalizedParams = normalizeDataTypeParams(dbType, baseType, params);
  const mysqlType = combineMysqlNumericAttributeType(dbType, baseType, normalizedParams);
  if (mysqlType) return mysqlType;
  return combineDataType(baseType, normalizedParams);
}

export function dataTypeLengthInputValue(dbType: DatabaseType | undefined, rawDataType: string): string {
  const parsed = splitDataType(rawDataType);
  return isDataTypeLengthDisabled(dbType, parsed.baseType) ? "" : parsed.params;
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
    case "questdb":
      return ["timestamp"].includes(normalized);
    default:
      return false;
  }
}

function combineMysqlNumericAttributeType(dbType: DatabaseType | undefined, baseType: string, params: string): string | null {
  if (!params || !isMysqlLikeStructureType(dbType)) return null;
  const parts = baseType.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const typeName = parts[0]?.toLowerCase();
  if (!typeName || !["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "real", "double", "float", "decimal", "numeric"].includes(typeName)) return null;
  const attrIndex = parts.findIndex((part) => ["signed", "unsigned", "zerofill"].includes(part.toLowerCase()));
  if (attrIndex === -1) return null;
  if (!parts.slice(attrIndex).every((part) => ["signed", "unsigned", "zerofill"].includes(part.toLowerCase()))) return null;
  return `${parts.slice(0, attrIndex).join(" ")}(${params}) ${parts.slice(attrIndex).join(" ")}`;
}

function isMysqlLikeStructureType(dbType: DatabaseType | undefined): boolean {
  return dbType === "mysql" || dbType === "doris" || dbType === "starrocks" || dbType === "goldendb" || dbType === "sundb" || dbType === "databend";
}

function isValidTemporalPrecision(dbType: DatabaseType | undefined, params: string): boolean {
  if (!/^\d+$/.test(params)) return false;
  const value = Number(params);
  const max = dbType === "oracle" || dbType === "dameng" || dbType === "oceanbase-oracle" ? 9 : 6;
  return Number.isInteger(value) && value >= 0 && value <= max && String(value) === params;
}

export function getDefaultLengthForType(_dbType: DatabaseType | undefined, baseType: string): string {
  const key = baseType.trim().toLowerCase();
  if (_dbType === "questdb") {
    return QUESTDB_TYPE_LENGTHS[key] ?? "";
  } else {
    return DEFAULT_TYPE_LENGTHS[key] ?? "";
  }
}

export function isDataTypeLengthDisabled(_dbType: DatabaseType | undefined, baseType: string): boolean {
  const key = baseType.trim().toLowerCase();
  if (_dbType === "questdb") {
    return key !== "geohash" && key !== "decimal";
  } else if (_dbType === "manticoresearch") {
    return key !== "bit" && key !== "float_vector";
  } else if (_dbType === "postgres" || _dbType === "gaussdb" || _dbType === "kwdb" || _dbType === "opengauss" || _dbType === "highgo" || _dbType === "vastbase" || _dbType === "kingbase") {
    return POSTGRES_TYPE_LENGTH_DISABLES.includes(key);
  } else if (isMysqlLikeStructureType(_dbType)) {
    return key === "enum" || key === "set";
  } else {
    return DEFAULT_TYPE_LENGTH_DISABLES.includes(key);
  }
}

export function buildStructureTargetLabel(connectionName: string | undefined, database: string | undefined, schema: string | undefined, tableName: string | undefined): string {
  const parts = [connectionName, database];
  if (schema && schema !== database) parts.push(schema);
  if (tableName) parts.push(tableName);
  return parts.filter(Boolean).join(" / ");
}
