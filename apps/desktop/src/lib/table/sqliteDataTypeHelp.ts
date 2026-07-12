export type SqliteDataTypeHelpKey = "integer" | "real" | "text" | "blob" | "numeric";

export interface SqliteDataTypeHelp {
  key: SqliteDataTypeHelpKey;
}

const SQLITE_TYPE_HELP_KEYS: Readonly<Record<string, SqliteDataTypeHelpKey>> = {
  integer: "integer",
  real: "real",
  text: "text",
  blob: "blob",
  numeric: "numeric",
};

const SQLITE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  tinyint: "integer",
  smallint: "integer",
  mediumint: "integer",
  bigint: "integer",
  "unsigned big int": "integer",
  float: "real",
  double: "real",
  "double precision": "real",
  boolean: "numeric",
  bool: "numeric",
  decimal: "numeric",
  date: "numeric",
  datetime: "numeric",
  time: "numeric",
  varchar: "text",
  nvarchar: "text",
  char: "text",
  nchar: "text",
  clob: "text",
};

/**
 * Returns help for SQLite's storage classes and common declared-type aliases.
 * SQLite accepts arbitrary type names, so unknown application-specific names
 * deliberately receive no generic hint.
 */
export function getSqliteDataTypeHelp(rawType: string): SqliteDataTypeHelp | undefined {
  const normalized = rawType
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const canonicalType = SQLITE_TYPE_ALIASES[normalized] ?? normalized;
  const key = SQLITE_TYPE_HELP_KEYS[canonicalType];
  return key ? { key } : undefined;
}
