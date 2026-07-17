export type MysqlDataTypeHelpKey =
  | "tinyint"
  | "smallint"
  | "mediumint"
  | "int"
  | "bigint"
  | "decimal"
  | "float"
  | "double"
  | "real"
  | "bit"
  | "boolean"
  | "serial"
  | "date"
  | "datetime"
  | "timestamp"
  | "time"
  | "year"
  | "char"
  | "varchar"
  | "tinytext"
  | "text"
  | "mediumtext"
  | "longtext"
  | "binary"
  | "varbinary"
  | "tinyblob"
  | "blob"
  | "mediumblob"
  | "longblob"
  | "enum"
  | "set"
  | "json"
  | "jsonMysql"
  | "jsonMariaDb"
  | "nationalCharacter"
  | "geometry"
  | "point"
  | "linestring"
  | "polygon"
  | "multipoint"
  | "multilinestring"
  | "multipolygon"
  | "geometrycollection"
  | "inet4"
  | "inet6"
  | "uuid"
  | "vector"
  | "xmltype"
  | "integerDisplayWidth"
  | "zerofill"
  | "unsignedNumeric"
  | "floatPrecision"
  | "floatingPointDisplay";

export interface MysqlDataTypeHelp {
  key: MysqlDataTypeHelpKey;
  warningKeys?: MysqlDataTypeHelpKey[];
}

export interface MysqlDataTypeHelpOptions {
  /** Set only when the selected connection profile identifies the server product. */
  product?: "mysql" | "mariadb";
}

const MYSQL_TYPE_HELP_KEYS: Readonly<Record<string, MysqlDataTypeHelpKey>> = {
  tinyint: "tinyint",
  smallint: "smallint",
  mediumint: "mediumint",
  int: "int",
  bigint: "bigint",
  decimal: "decimal",
  float: "float",
  double: "double",
  real: "real",
  bit: "bit",
  boolean: "boolean",
  nationalCharacter: "nationalCharacter",
  serial: "serial",
  date: "date",
  datetime: "datetime",
  timestamp: "timestamp",
  time: "time",
  year: "year",
  char: "char",
  varchar: "varchar",
  tinytext: "tinytext",
  text: "text",
  mediumtext: "mediumtext",
  longtext: "longtext",
  binary: "binary",
  varbinary: "varbinary",
  tinyblob: "tinyblob",
  blob: "blob",
  mediumblob: "mediumblob",
  longblob: "longblob",
  enum: "enum",
  set: "set",
  json: "json",
  geometry: "geometry",
  point: "point",
  linestring: "linestring",
  polygon: "polygon",
  multipoint: "multipoint",
  multilinestring: "multilinestring",
  multipolygon: "multipolygon",
  geometrycollection: "geometrycollection",
  inet4: "inet4",
  inet6: "inet6",
  uuid: "uuid",
  vector: "vector",
  xmltype: "xmltype",
};

const MYSQL_TYPE_ALIASES: Readonly<Record<string, string>> = {
  integer: "int",
  numeric: "decimal",
  dec: "decimal",
  fixed: "decimal",
  bool: "boolean",
  "character varying": "varchar",
  character: "char",
  "char varying": "varchar",
  "char byte": "char",
  nchar: "nationalCharacter",
  nvarchar: "nationalCharacter",
  "nchar varying": "nationalCharacter",
  "national char": "nationalCharacter",
  "national character": "nationalCharacter",
  "national varchar": "nationalCharacter",
  "national char varying": "nationalCharacter",
  "national character varying": "nationalCharacter",
  "double precision": "double",
  float4: "float",
  float8: "double",
  int1: "tinyint",
  int2: "smallint",
  int3: "mediumint",
  int4: "int",
  int8: "bigint",
  middleint: "mediumint",
  long: "mediumtext",
  "long varchar": "mediumtext",
  "long varbinary": "mediumblob",
  geomcollection: "geometrycollection",
};

/**
 * Returns help for a MySQL-family type name without making a database request.
 * The caller is responsible for limiting this to connections that use MySQL
 * semantics, since several compatible databases accept similarly named types
 * with different limits.
 */
export function getMysqlDataTypeHelp(rawType: string, options: MysqlDataTypeHelpOptions = {}): MysqlDataTypeHelp | undefined {
  const normalized = normalizeMysqlType(rawType);
  const resolvedType = MYSQL_TYPE_ALIASES[normalized] ?? normalized;
  const baseKey = MYSQL_TYPE_HELP_KEYS[resolvedType];
  if (!baseKey) return undefined;

  const key = resolvedType === "json" ? jsonHelpKey(options.product) : baseKey;
  const warningKeys = mysqlDataTypeWarningKeys(rawType, resolvedType);
  return warningKeys.length > 0 ? { key, warningKeys } : { key };
}

function jsonHelpKey(product: MysqlDataTypeHelpOptions["product"]): MysqlDataTypeHelpKey {
  if (product === "mysql") return "jsonMysql";
  if (product === "mariadb") return "jsonMariaDb";
  return "json";
}

function mysqlDataTypeWarningKeys(rawType: string, resolvedType: string): MysqlDataTypeHelpKey[] {
  const lowered = rawType.trim().toLowerCase().replace(/\s+/g, " ");
  const warnings: MysqlDataTypeHelpKey[] = [];
  const isInteger = ["tinyint", "smallint", "mediumint", "int", "bigint"].includes(resolvedType);
  const isNumeric = isInteger || ["decimal", "float", "double", "real"].includes(resolvedType);

  if (isInteger && /\(\s*\d+\s*\)/.test(lowered)) warnings.push("integerDisplayWidth");
  if (isNumeric && /\bzerofill\b/.test(lowered)) warnings.push("zerofill");
  if (["decimal", "float", "double", "real"].includes(resolvedType) && /\bunsigned\b/.test(lowered)) warnings.push("unsignedNumeric");

  const parameters = lowered.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
  if (resolvedType === "float" && /^\d+$/.test(parameters)) {
    const precision = Number(parameters);
    if (precision >= 25 && precision <= 53) warnings.push("floatPrecision");
  }
  if (["float", "double"].includes(resolvedType) && /^\d+\s*,\s*\d+$/.test(parameters)) warnings.push("floatingPointDisplay");

  return warnings;
}

function normalizeMysqlType(rawType: string): string {
  return rawType
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:unsigned|signed|zerofill)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
