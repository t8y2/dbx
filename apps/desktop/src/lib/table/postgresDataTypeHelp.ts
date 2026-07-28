export type PostgresDataTypeHelpKey =
  | "smallint"
  | "integer"
  | "bigint"
  | "serial"
  | "numeric"
  | "real"
  | "double"
  | "money"
  | "boolean"
  | "char"
  | "varchar"
  | "text"
  | "bytea"
  | "date"
  | "time"
  | "timetz"
  | "timestamp"
  | "timestamptz"
  | "interval"
  | "uuid"
  | "json"
  | "jsonb"
  | "xml"
  | "bit"
  | "tsvector"
  | "tsquery"
  | "cidr"
  | "inet"
  | "macaddr"
  | "geometry"
  | "range"
  | "oid"
  | "array"
  | "multirange"
  | "jsonpath"
  | "pgLsn"
  | "pgSnapshot";

export interface PostgresDataTypeHelp {
  key: PostgresDataTypeHelpKey;
}

const POSTGRES_TYPE_HELP_KEYS: Readonly<Record<string, PostgresDataTypeHelpKey>> = {
  smallint: "smallint",
  integer: "integer",
  bigint: "bigint",
  smallserial: "serial",
  serial: "serial",
  bigserial: "serial",
  numeric: "numeric",
  real: "real",
  "double precision": "double",
  money: "money",
  boolean: "boolean",
  char: "char",
  varchar: "varchar",
  text: "text",
  bytea: "bytea",
  date: "date",
  time: "time",
  timetz: "timetz",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  interval: "interval",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  xml: "xml",
  bit: "bit",
  "bit varying": "bit",
  tsvector: "tsvector",
  tsquery: "tsquery",
  cidr: "cidr",
  inet: "inet",
  macaddr: "macaddr",
  macaddr8: "macaddr",
  point: "geometry",
  line: "geometry",
  lseg: "geometry",
  box: "geometry",
  path: "geometry",
  polygon: "geometry",
  circle: "geometry",
  int4range: "range",
  int8range: "range",
  numrange: "range",
  tsrange: "range",
  tstzrange: "range",
  daterange: "range",
  oid: "oid",
  jsonpath: "jsonpath",
  pg_lsn: "pgLsn",
  pg_snapshot: "pgSnapshot",
};

const POSTGRES_TYPE_ALIASES: Readonly<Record<string, string>> = {
  int2: "smallint",
  int: "integer",
  int4: "integer",
  int8: "bigint",
  decimal: "numeric",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  character: "char",
  "character varying": "varchar",
  "time without time zone": "time",
  "time with time zone": "timetz",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  varbit: "bit varying",
};

const POSTGRES_MULTIRANGE_TYPES = new Set(["int4multirange", "int8multirange", "nummultirange", "tsmultirange", "tstzmultirange", "datemultirange"]);

/**
 * Returns static PostgreSQL type help without querying the server. Extension
 * types and user-defined types intentionally remain undocumented.
 */
export function getPostgresDataTypeHelp(rawType: string): PostgresDataTypeHelp | undefined {
  const normalized = normalizePostgresType(rawType);
  if (isPostgresArrayType(normalized)) return { key: "array" };

  const baseType = normalized
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (baseType === "float") {
    const key = floatHelpKey(normalized);
    return key ? { key } : undefined;
  }
  if (POSTGRES_MULTIRANGE_TYPES.has(baseType)) return { key: "multirange" };

  const canonicalType = POSTGRES_TYPE_ALIASES[baseType] ?? baseType;
  const key = POSTGRES_TYPE_HELP_KEYS[canonicalType];
  return key ? { key } : undefined;
}

function normalizePostgresType(rawType: string): string {
  return rawType.trim().toLowerCase().replace(/\s+/g, " ");
}

function isPostgresArrayType(normalizedType: string): boolean {
  return /(?:\[\s*\]\s*)+$/.test(normalizedType);
}

function floatHelpKey(normalizedType: string): "real" | "double" | undefined {
  if (normalizedType === "float") return "double";
  const precision = normalizedType.match(/^float\(\s*(\d+)\s*\)$/)?.[1];
  if (!precision) return undefined;
  const value = Number(precision);
  if (value >= 1 && value <= 24) return "real";
  return value >= 25 && value <= 53 ? "double" : undefined;
}
