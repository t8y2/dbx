import { Cassandra, MariaSQL, MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import type { DatabaseType, SqlSnippet } from "@/types/database";
import { buildMongoCompletionItemsFromContext, type MongoCompletionItem } from "@/lib/mongo/mongoCompletion";
import { CLOUDFLARE_D1_COMMON_FUNCTION_NAMES } from "@/lib/sql/cloudflareD1";
import type { SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "ASC",
  "DESC",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "VIEW",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "LIKE",
  "DISTINCT",
  "UNION",
  "ALL",
  "EXISTS",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IF",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "IIF",
  "CHOOSE",
  "COALESCE",
  "CAST",
  "ALTER",
  "DROP",
  "ADD",
  "COLUMN",
  "INDEX",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "CONSTRAINT",
  "DEFAULT",
  "CHECK",
  "UNIQUE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRUNCATE",
  "EXPLAIN",
  "ANALYZE",
  "WITH",
  "RECURSIVE",
  "OVER",
  "PARTITION BY",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTILE",
  "CROSS",
  "APPLY",
  "CROSS APPLY",
  "OUTER APPLY",
  "ISJSON",
  "JSON_ARRAY",
  "JSON_ARRAYAGG",
  "JSON_ARRAY_APPEND",
  "JSON_ARRAY_INSERT",
  "JSON_CONTAINS",
  "JSON_CONTAINS_PATH",
  "JSON_DEPTH",
  "JSON_EXTRACT",
  "JSON_INSERT",
  "JSON_KEYS",
  "JSON_LENGTH",
  "JSON_MERGE_PATCH",
  "JSON_MERGE_PRESERVE",
  "JSON_MODIFY",
  "JSON_OBJECT",
  "JSON_OBJECTAGG",
  "JSON_OVERLAPS",
  "JSON_PATH_EXISTS",
  "JSON_PRETTY",
  "JSON_QUERY",
  "JSON_QUOTE",
  "JSON_REMOVE",
  "JSON_REPLACE",
  "JSON_SCHEMA_VALID",
  "JSON_SEARCH",
  "JSON_SET",
  "JSON_STORAGE_FREE",
  "JSON_STORAGE_SIZE",
  "JSON_TABLE",
  "JSON_TYPE",
  "JSON_UNQUOTE",
  "JSON_VALID",
  "JSON_VALUE",
  "OPENJSON",
  "OPENXML",
  "OPENROWSET",
  "FULL",
  "NATURAL",
  "USING",
  "LATERAL",
  "UNNEST",
  "FILTER",
  "EXCLUDE",
  "REPLACE",
  "QUALIFY",
  "PIVOT",
  "UNPIVOT",
  "ASOF",
  "POSITIONAL",
  "ANTI",
  "SEMI",
  "SAMPLE",
  "TABLESAMPLE",
  "STRUCT",
  "MAP",
  "LIST",
  "ARRAY",
  "LAMBDA",
  "LIST_TRANSFORM",
  "READ_CSV",
  "READ_PARQUET",
  "READ_JSON",
  "COPY",
  "EXPORT",
  "IMPORT",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "PRAGMA",
  "BIGINT",
  "BINARY",
  "BIT",
  "CHAR",
  "DATE",
  "DATETIME",
  "DATETIME2",
  "DATETIMEOFFSET",
  "DECIMAL",
  "FLOAT",
  "IMAGE",
  "INT",
  "MONEY",
  "NCHAR",
  "NTEXT",
  "NUMERIC",
  "NVARCHAR",
  "REAL",
  "SMALLDATETIME",
  "SMALLINT",
  "SMALLMONEY",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "TINYINT",
  "UNIQUEIDENTIFIER",
  "VARBINARY",
  "VARCHAR",
  "XML",
  // Common built-in functions
  "ABS",
  "CEIL",
  "CEILING",
  "FLOOR",
  "ROUND",
  "MOD",
  "POWER",
  "SQRT",
  "SIGN",
  "TRUNCATE",
  "CONCAT",
  "CONCAT_WS",
  "LENGTH",
  "CHAR_LENGTH",
  "UPPER",
  "LOWER",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "SUBSTRING",
  "SUBSTR",
  "INSTR",
  "LOCATE",
  "LPAD",
  "RPAD",
  "REVERSE",
  "REPEAT",
  "SPACE",
  "FORMAT",
  "HEX",
  "UNHEX",
  "NOW",
  "CURDATE",
  "CURTIME",
  "DATE_ADD",
  "DATE_SUB",
  "DATE_FORMAT",
  "DATEDIFF",
  "TIMESTAMPDIFF",
  "EXTRACT",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "DAYOFWEEK",
  "DAYOFYEAR",
  "LAST_DAY",
  "STR_TO_DATE",
  "CONVERT",
  "IFNULL",
  "NULLIF",
  "GREATEST",
  "LEAST",
  "GROUP_CONCAT",
  "FIND_IN_SET",
  "FIELD",
  "ELT",
  "REGEXP",
  "REGEXP_LIKE",
  "REGEXP_REPLACE",
  "REGEXP_SUBSTR",
  "UUID",
  "MD5",
  "SHA1",
  "SHA2",
  "CRC32",
];

const COMMON_SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "ASC",
  "DESC",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "VIEW",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "LIKE",
  "DISTINCT",
  "UNION",
  "ALL",
  "EXISTS",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
  "ALTER",
  "DROP",
  "ADD",
  "COLUMN",
  "INDEX",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "CONSTRAINT",
  "DEFAULT",
  "CHECK",
  "UNIQUE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRUNCATE",
  "EXPLAIN",
  "ANALYZE",
  "WITH",
  "RECURSIVE",
  "OVER",
  "PARTITION BY",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTILE",
  "BIGINT",
  "BINARY",
  "BIT",
  "CHAR",
  "DATE",
  "DECIMAL",
  "FLOAT",
  "INT",
  "NUMERIC",
  "REAL",
  "SMALLINT",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "VARCHAR",
];

const POSTGRES_SQL_KEYWORDS = [
  "BIGSERIAL",
  "JSON",
  "JSONB",
  "SMALLSERIAL",
  "SERIAL",
  "UUID",
  "INET",
  "CIDR",
  "MACADDR",
  "MACADDR8",
  "TSVECTOR",
  "TSQUERY",
  "BYTEA",
  "BOOLEAN",
  "RETURNING",
  "ILIKE",
  "SIMILAR TO",
  "ON CONFLICT",
  "DO NOTHING",
  "DO UPDATE",
  "GENERATED",
  "IDENTITY",
  "MATERIALIZED",
  "VACUUM",
  "ARRAY_AGG",
  "JSONB_BUILD_OBJECT",
  "JSONB_AGG",
  "TO_JSONB",
  "CURRENT_TIMESTAMP",
];

const MYSQL_SQL_KEYWORDS = [
  "AUTO_INCREMENT",
  "UNSIGNED",
  "ZEROFILL",
  "ENGINE",
  "CHARSET",
  "COLLATE",
  "ENUM",
  "JSON",
  "BOOL",
  "BOOLEAN",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "SHOW",
  "DESCRIBE",
  "REPLACE",
  "DUPLICATE KEY",
  "JSON_EXTRACT",
  "JSON_UNQUOTE",
  "DATE_FORMAT",
];

const MANTICORESEARCH_SQL_KEYWORDS = ["FACET", "MATCH", "SHOW", "SHOW META", "SHOW TABLES", "CALL", "CALL PQ", "PQ", "META", "TABLES", "OPTION", "WITHIN GROUP ORDER BY"];

const SQLITE_SQL_KEYWORDS = ["AUTOINCREMENT", "INTEGER", "BLOB", "BOOLEAN", "WITHOUT ROWID", "VACUUM", "PRAGMA", "JSON_EXTRACT", "JSON_SET", "STRFTIME"];

const SQLSERVER_SQL_KEYWORDS = [
  "TOP",
  "IDENTITY",
  "IDENTITY_INSERT",
  "UNIQUEIDENTIFIER",
  "NVARCHAR",
  "DATETIME2",
  "DATETIMEOFFSET",
  "BIT",
  "GO",
  "MERGE",
  "OUTPUT",
  "TRY_CAST",
  "TRY_CONVERT",
  "OPENJSON",
  "JSON_VALUE",
  "JSON_QUERY",
  "NOCOUNT",
  "XACT_ABORT",
  "ANSI_NULLS",
  "ANSI_PADDING",
  "ANSI_WARNINGS",
  "ANSI_DEFAULTS",
  "ARITHABORT",
  "ARITHIGNORE",
  "QUOTED_IDENTIFIER",
  "IMPLICIT_TRANSACTIONS",
  "TRANSACTION ISOLATION LEVEL",
  "DATEFIRST",
  "DATEFORMAT",
  "DEADLOCK_PRIORITY",
  "LOCK_TIMEOUT",
  "ROWCOUNT",
  "TEXTSIZE",
  "STATISTICS IO",
  "STATISTICS TIME",
  "STATISTICS XML",
  "SHOWPLAN_ALL",
  "SHOWPLAN_TEXT",
  "SHOWPLAN_XML",
];

function sqlDialectCompletionWords(...sources: Array<string | undefined>): string[] {
  return sources
    .flatMap((source) => (source ?? "").split(/\s+/))
    .filter((keyword) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(keyword))
    .map((keyword) => keyword.toUpperCase());
}

const ORACLE_SQL_TYPES = [
  "BFILE",
  "BINARY_DOUBLE",
  "BINARY_FLOAT",
  "BLOB",
  "CHAR",
  "CLOB",
  "DATE",
  "DEC",
  "DECIMAL",
  "DOUBLE PRECISION",
  "FLOAT",
  "INT",
  "INTEGER",
  "INTERVAL DAY TO SECOND",
  "INTERVAL YEAR TO MONTH",
  "LONG",
  "LONG RAW",
  "NCHAR",
  "NCLOB",
  "NUMBER",
  "NUMERIC",
  "NVARCHAR2",
  "RAW",
  "REAL",
  "ROWID",
  "SMALLINT",
  "TIMESTAMP",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "TIMESTAMP WITH TIME ZONE",
  "UROWID",
  "VARCHAR",
  "VARCHAR2",
  "XMLTYPE",
];

const ORACLE_SYSTEM_VALUE_NAMES = ["SYSDATE", "SYSTIMESTAMP", "CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "SESSIONTIMEZONE", "DBTIMEZONE", "USER", "UID"] as const;

const ORACLE_SYSTEM_VALUE_NAME_SET = new Set<string>(ORACLE_SYSTEM_VALUE_NAMES);

export function isOracleSystemValueName(name: string, databaseType?: DatabaseType): boolean {
  return isOracleLikeDatabase(databaseType) && ORACLE_SYSTEM_VALUE_NAME_SET.has(name.toUpperCase());
}

const NON_ORACLE_COMPLETION_WORDS = new Set(["BIGSERIAL", "BOOLEAN", "ELSEIF", "LIMIT", "LOCALTIME", "SERIAL", "STRING", "TEXT", "TIME", "USE"]);

const ORACLE_SQL_KEYWORDS = Array.from(
  new Set([
    ...sqlDialectCompletionWords(PLSQL.spec.keywords).filter((keyword) => !NON_ORACLE_COMPLETION_WORDS.has(keyword)),
    ...ORACLE_SQL_TYPES,
    "BULK COLLECT",
    "CONNECT BY",
    "DATABASE LINK",
    "EXECUTE IMMEDIATE",
    "FLASHBACK",
    "FOR UPDATE",
    "MATERIALIZED VIEW",
    "MERGE",
    "ORDER SIBLINGS BY",
    "OR REPLACE",
    "PACKAGE BODY",
    "PURGE",
    "RETURNING INTO",
    "SEQUENCE",
    "START WITH",
    "TYPE BODY",
  ]),
);

const DATABASE_SQL_KEYWORDS: Partial<Record<DatabaseType, string[]>> = {
  mysql: MYSQL_SQL_KEYWORDS,
  postgres: POSTGRES_SQL_KEYWORDS,
  sqlite: SQLITE_SQL_KEYWORDS,
  rqlite: SQLITE_SQL_KEYWORDS,
  turso: SQLITE_SQL_KEYWORDS,
  "cloudflare-d1": SQLITE_SQL_KEYWORDS,
  sqlserver: SQLSERVER_SQL_KEYWORDS,
  oracle: ORACLE_SQL_KEYWORDS,
  "oceanbase-oracle": ORACLE_SQL_KEYWORDS,
  manticoresearch: MANTICORESEARCH_SQL_KEYWORDS,
};

// Keywords that appear in nearly every SQL query — boosted so frequency beats length tie-breaking.
// E.g. typing "WH" should rank WHERE (high frequency) above WHEN (CASE-only).
const HIGH_FREQUENCY_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "JOIN",
  "ON",
  "IN",
  "AS",
  "GROUP BY",
  "ORDER BY",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "NOT",
  "NULL",
  "IS",
  "LIKE",
  "DISTINCT",
  "HAVING",
  "LIMIT",
  "COUNT",
  "SUM",
  "AVG",
  "MAX",
  "MIN",
  "CASE",
  "UNION",
  "ALL",
  "ASC",
  "DESC",
  "BETWEEN",
  "EXISTS",
]);

const TABLE_TRIGGER_KEYWORDS = new Set(["from", "join", "update", "into", "table", "describe", "explain", "apply"]);
const EXCLUSIVE_TABLE_TRIGGER_KEYWORDS = new Set(["from", "join", "update", "into", "apply"]);
const JOIN_MODIFIERS = new Set(["left", "right", "inner", "outer", "cross", "full", "natural"]);
const JOIN_MODIFIER_KEYWORD_PHRASES = ["LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "NATURAL JOIN", "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN"];
const MAX_TABLE_COMPLETION_ITEMS = 200;
const EXACT_LABEL_MATCH_BOOST = 10000;

// Keywords that only make sense in DDL / statement-start contexts (not inside SELECT/INSERT/UPDATE/DELETE)
const DDL_ONLY_KEYWORDS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "VIEW",
  "INDEX",
  "COLUMN",
  "ADD",
  "CONSTRAINT",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "DEFAULT",
  "CHECK",
  "UNIQUE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRUNCATE",
  "EXPLAIN",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "PRAGMA",
  "COPY",
  "EXPORT",
  "IMPORT",
  "IF",
]);

// Data type keywords — only relevant in DDL (CREATE/ALTER TABLE)
const DATA_TYPE_KEYWORDS = new Set([
  "BIGINT",
  "BINARY",
  "BIT",
  "CHAR",
  "DATE",
  "DATETIME",
  "DATETIME2",
  "DATETIMEOFFSET",
  "DECIMAL",
  "FLOAT",
  "IMAGE",
  "INT",
  "MONEY",
  "NCHAR",
  "NTEXT",
  "NUMERIC",
  "NVARCHAR",
  "REAL",
  "SMALLDATETIME",
  "SMALLINT",
  "SMALLMONEY",
  "TEXT",
  "TIME",
  "TIMESTAMP",
  "TINYINT",
  "UNIQUEIDENTIFIER",
  "VARBINARY",
  "VARCHAR",
  "XML",
  "JSON",
  "JSONB",
  "UUID",
  "SERIAL",
  "BIGSERIAL",
  "SMALLSERIAL",
  "BYTEA",
  "BOOLEAN",
  "BOOL",
  "INET",
  "CIDR",
  "MACADDR",
  "MACADDR8",
  "TSVECTOR",
  "TSQUERY",
  "ENUM",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  ...ORACLE_SQL_TYPES,
]);

// Window functions that should use OVER() completion
const WINDOW_FUNCTIONS = new Set(["ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTILE"]);

function getFunctionDescriptions(t?: SqlCompletionTranslations): Map<string, string> {
  const d = t?.functionDescriptions ?? {};
  return new Map<string, string>([
    ["COUNT", d.COUNT || "Returns the number of rows"],
    ["SUM", d.SUM || "Returns the sum of a numeric column"],
    ["AVG", d.AVG || "Returns the average of a numeric column"],
    ["MIN", d.MIN || "Returns the minimum value"],
    ["MAX", d.MAX || "Returns the maximum value"],
    ["GROUP_CONCAT", d.GROUP_CONCAT || "Concatenates group values into a string"],
    ["STRING_AGG", d.STRING_AGG || "Concatenates strings in a group"],
    ["CONCAT", d.CONCAT || "Concatenates multiple strings"],
    ["CONCAT_WS", d.CONCAT_WS || "Concatenates strings with a separator"],
    ["SUBSTRING", d.SUBSTRING || "Extracts a substring"],
    ["REPLACE", d.REPLACE || "Replaces content in a string"],
    ["TRIM", d.TRIM || "Removes leading and trailing spaces"],
    ["UPPER", d.UPPER || "Converts to uppercase"],
    ["LOWER", d.LOWER || "Converts to lowercase"],
    ["LENGTH", d.LENGTH || "Returns string length"],
    ["REGEXP_REPLACE", d.REGEXP_REPLACE || "Replaces using a regular expression"],
    ["DATE_FORMAT", d.DATE_FORMAT || "Formats a date with a pattern"],
    ["DATEDIFF", d.DATEDIFF || "Calculates the difference between two dates"],
    ["DATE_ADD", d.DATE_ADD || "Adds to a date"],
    ["DATE_SUB", d.DATE_SUB || "Subtracts from a date"],
    ["EXTRACT", d.EXTRACT || "Extracts a part from a date"],
    ["NOW", d.NOW || "Returns the current date and time"],
    ["ROUND", d.ROUND || "Rounds to the specified precision"],
    ["FLOOR", d.FLOOR || "Rounds down"],
    ["CEIL", d.CEIL || "Rounds up"],
    ["ABS", d.ABS || "Returns the absolute value"],
    ["MOD", d.MOD || "Returns the remainder"],
    ["COALESCE", d.COALESCE || "Returns the first non-NULL argument"],
    ["IFNULL", d.IFNULL || "Returns an alternate value when NULL"],
    ["NULLIF", d.NULLIF || "Returns NULL when values are equal"],
    ["CAST", d.CAST || "Converts an expression to a specified type"],
    ["JSON_EXTRACT", d.JSON_EXTRACT || "Extracts a value from JSON"],
    ["JSON_VALUE", d.JSON_VALUE || "Extracts a scalar value from JSON"],
    ["JSON_OBJECT", d.JSON_OBJECT || "Creates a JSON object"],
    ["JSON_ARRAY", d.JSON_ARRAY || "Creates a JSON array"],
  ]);
}

export const DEFAULT_SQL_SNIPPETS: SqlSnippet[] = [
  {
    id: "builtin-sel",
    label: "select *",
    prefix: "sel",
    body: "SELECT *\nFROM table\nLIMIT 100;",
    enabled: true,
  },
  {
    id: "builtin-ins",
    label: "insert into",
    prefix: "ins",
    body: "INSERT INTO table (columns)\nVALUES (values);",
    enabled: true,
  },
  {
    id: "builtin-upd",
    label: "update set",
    prefix: "upd",
    body: "UPDATE table\nSET column = value\nWHERE condition;",
    enabled: true,
  },
  {
    id: "builtin-cte",
    label: "common table expression",
    prefix: "cte",
    body: "WITH name AS (\n  SELECT columns\n  FROM table\n)\nSELECT *\nFROM name;",
    enabled: true,
  },
  {
    id: "builtin-join",
    label: "join",
    prefix: "join",
    body: "JOIN table ON left_column = right_column",
    enabled: true,
  },
  {
    id: "builtin-case",
    label: "case when",
    prefix: "case",
    body: "CASE\n  WHEN condition THEN value\n  ELSE default\nEND",
    enabled: true,
  },
  {
    id: "builtin-ct",
    label: "create table",
    prefix: "ct",
    body: "CREATE TABLE table (\n  column type\n);",
    enabled: true,
  },
  {
    id: "builtin-ex",
    label: "exists",
    prefix: "ex",
    body: "EXISTS (\n  SELECT 1\n  FROM table\n  WHERE condition\n)",
    enabled: true,
  },
  {
    id: "builtin-nex",
    label: "not exists",
    prefix: "nex",
    body: "NOT EXISTS (\n  SELECT 1\n  FROM table\n  WHERE condition\n)",
    enabled: true,
  },
  {
    id: "builtin-at",
    label: "alter table add column",
    prefix: "at",
    body: "ALTER TABLE table\nADD COLUMN column type;",
    enabled: true,
  },
  {
    id: "builtin-ci",
    label: "create index",
    prefix: "ci",
    body: "CREATE INDEX idx_name\nON table (column);",
    enabled: true,
  },
];

const MANTICORESEARCH_SQL_SNIPPETS: SqlSnippet[] = [
  {
    id: "builtin-manticore-match",
    label: "match query",
    prefix: "match",
    body: "MATCH('query')",
  },
  {
    id: "builtin-manticore-facet",
    label: "facet",
    prefix: "facet",
    body: "FACET column",
  },
  {
    id: "builtin-manticore-show-meta",
    label: "show meta",
    prefix: "m",
    body: "SHOW META;",
  },
  {
    id: "builtin-manticore-show-tables",
    label: "show tables",
    prefix: "tab",
    body: "SHOW TABLES;",
  },
  {
    id: "builtin-manticore-call-pq",
    label: "call pq",
    prefix: "p",
    body: "CALL PQ ('pq', ('{\"title\":\"query\"}'));",
  },
];

const SQL_FUNCTION_SIGNATURES = new Map<string, string[]>([
  // Aggregate
  ["COUNT", ["expression"]],
  ["SUM", ["expression"]],
  ["AVG", ["expression"]],
  ["MIN", ["expression"]],
  ["MAX", ["expression"]],
  ["GROUP_CONCAT", ["expression", "separator"]],
  ["STRING_AGG", ["expression", "separator"]],
  ["ARRAY_AGG", ["expression"]],
  // String
  ["CONCAT", ["value", "...values"]],
  ["CONCAT_WS", ["separator", "...values"]],
  ["SUBSTRING", ["string", "start", "length"]],
  ["SUBSTR", ["string", "start", "length"]],
  ["REPLACE", ["string", "old", "new"]],
  ["TRIM", ["string"]],
  ["LTRIM", ["string"]],
  ["RTRIM", ["string"]],
  ["UPPER", ["string"]],
  ["LOWER", ["string"]],
  ["LENGTH", ["string"]],
  ["LPAD", ["string", "length", "pad"]],
  ["RPAD", ["string", "length", "pad"]],
  ["INSTR", ["string", "substring"]],
  ["LOCATE", ["substring", "string"]],
  ["REVERSE", ["string"]],
  ["REPEAT", ["string", "count"]],
  ["SPACE", ["count"]],
  ["FORMAT", ["number", "decimals"]],
  ["REGEXP_REPLACE", ["string", "pattern", "replacement"]],
  ["REGEXP_SUBSTR", ["string", "pattern"]],
  ["SPLIT_PART", ["string", "delimiter", "part"]],
  // Date / Time
  ["DATE_FORMAT", ["date", "format"]],
  ["DATEDIFF", ["date1", "date2"]],
  ["TIMESTAMPDIFF", ["unit", "datetime_expr1", "datetime_expr2"]],
  ["DATE_ADD", ["date", "interval"]],
  ["DATE_SUB", ["date", "interval"]],
  ["EXTRACT", ["unit", "date"]],
  ["YEAR", ["date"]],
  ["MONTH", ["date"]],
  ["DAY", ["date"]],
  ["HOUR", ["datetime"]],
  ["MINUTE", ["datetime"]],
  ["SECOND", ["datetime"]],
  ["DAYOFWEEK", ["date"]],
  ["DAYOFYEAR", ["date"]],
  ["LAST_DAY", ["date"]],
  ["STR_TO_DATE", ["string", "format"]],
  ["NOW", []],
  ["CURDATE", []],
  ["CURTIME", []],
  // Numeric
  ["ROUND", ["number", "decimals"]],
  ["FLOOR", ["number"]],
  ["CEIL", ["number"]],
  ["CEILING", ["number"]],
  ["ABS", ["number"]],
  ["MOD", ["dividend", "divisor"]],
  ["POWER", ["base", "exponent"]],
  ["SQRT", ["number"]],
  ["SIGN", ["number"]],
  ["TRUNCATE", ["number", "decimals"]],
  ["RAND", []],
  // Conditional
  ["COALESCE", ["value", "...values"]],
  ["IFNULL", ["expression", "fallback"]],
  ["NULLIF", ["expression1", "expression2"]],
  ["CAST", ["expression AS type"]],
  ["CONVERT", ["expression", "type"]],
  ["GREATEST", ["...values"]],
  ["LEAST", ["...values"]],
  ["IIF", ["condition", "true_value", "false_value"]],
  // Hash / Crypto
  ["MD5", ["string"]],
  ["SHA1", ["string"]],
  ["SHA2", ["string", "bit_length"]],
  ["UUID", []],
  // JSON
  ["JSON_EXTRACT", ["json", "path"]],
  ["JSON_VALUE", ["json", "path"]],
  ["JSON_QUERY", ["json", "path"]],
  ["JSON_OBJECT", ["key", "value", "...pairs"]],
  ["JSON_ARRAY", ["...values"]],
  ["JSON_SET", ["json", "path", "value"]],
  ["JSON_REMOVE", ["json", "path"]],
  ["JSON_CONTAINS", ["json", "value"]],
  ["JSON_LENGTH", ["json"]],
  ["JSON_KEYS", ["json"]],
  ["JSON_TYPE", ["json"]],
  ["JSON_PRETTY", ["json"]],
  ["JSON_VALID", ["json"]],
  ["JSON_ARRAYAGG", ["expression"]],
  ["JSON_OBJECTAGG", ["key", "value"]],
]);

const POSTGRES_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ["JSONB_BUILD_OBJECT", ["key", "value", "...pairs"]],
  ["JSONB_AGG", ["expression"]],
  ["TO_JSONB", ["value"]],
  ["JSONB_SET", ["target", "path", "new_value"]],
  ["ARRAY_AGG", ["expression"]],
  ["STRING_AGG", ["expression", "delimiter"]],
  ["GEN_RANDOM_UUID", []],
  ["NOW", []],
]);

const MYSQL_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ["CONVERT", ["expression", "type"]],
  ["DATE_FORMAT", ["date", "format"]],
  ["FROM_UNIXTIME", ["unix_timestamp"]],
  ["UNIX_TIMESTAMP", []],
  ["SYSDATE", []],
  ["JSON_EXTRACT", ["json", "path"]],
  ["JSON_UNQUOTE", ["json"]],
  ["GROUP_CONCAT", ["expression"]],
  ["UUID", []],
  ["NOW", []],
]);

const SQLITE_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ["JSON_EXTRACT", ["json", "path"]],
  ["JSON_SET", ["json", "path", "value"]],
  ["STRFTIME", ["format", "time"]],
  ["IFNULL", ["expression", "fallback"]],
  ["NOW", []],
]);

const CLOUDFLARE_D1_FUNCTION_SIGNATURES = new Map(Array.from(SQLITE_FUNCTION_SIGNATURES.entries()).filter(([name]) => name !== "NOW"));

const SQLSERVER_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ["CONVERT", ["type", "expression"]],
  ["TRY_CAST", ["expression AS type"]],
  ["TRY_CONVERT", ["type", "expression"]],
  ["JSON_VALUE", ["expression", "path"]],
  ["JSON_QUERY", ["expression", "path"]],
  ["NEWID", []],
  ["GETDATE", []],
  ["GETUTCDATE", []],
  ["SYSDATETIME", []],
  ["SYSUTCDATETIME", []],
  ["DATEADD", ["datepart", "number", "date"]],
  ["DATEDIFF", ["datepart", "startdate", "enddate"]],
  ["DATEPART", ["datepart", "date"]],
  ["DATENAME", ["datepart", "date"]],
  ["EOMONTH", ["start_date"]],
  ["CHARINDEX", ["substring", "string"]],
  ["PATINDEX", ["pattern", "string"]],
  ["LEN", ["string"]],
  ["STUFF", ["string", "start", "length", "replace"]],
  ["ISNULL", ["expression", "replacement"]],
]);

const MANTICORESEARCH_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ["MATCH", ["query"]],
  ["BM25F", ["field=weight", "...fields"]],
  ["EXIST", ["attribute", "default"]],
  ["IDF", ["keyword"]],
  ["PACKEDFACTORS", []],
  ["QUERY", []],
  ["REMAP", ["expression", "from_values", "to_values"]],
  ["SNIPPET", ["field", "query"]],
  ["WEIGHT", []],
  ["ZONESPANLIST", []],
  ["BIGINT", ["expression"]],
  ["DOUBLE", ["expression"]],
  ["INTEGER", ["expression"]],
  ["SINT", ["expression"]],
  ["TO_STRING", ["expression"]],
  ["UINT", ["expression"]],
  ["UINT64", ["expression"]],
  ["GEODIST", ["lat1", "lon1", "lat2", "lon2"]],
  ["CONTAINS", ["polygon", "point"]],
  ["POLY2D", ["...points"]],
  ["CRC32", ["expression"]],
  ["FIBONACCI", ["number"]],
  ["KNN_DIST", []],
  ["NOW", []],
  ["DATE_FORMAT", ["timestamp", "format"]],
  ["DAY", ["timestamp"]],
  ["MONTH", ["timestamp"]],
  ["YEAR", ["timestamp"]],
  ["HOUR", ["timestamp"]],
  ["MINUTE", ["timestamp"]],
  ["SECOND", ["timestamp"]],
]);

const DATABASE_FUNCTION_SIGNATURES: Partial<Record<DatabaseType, Map<string, string[]>>> = {
  mysql: MYSQL_FUNCTION_SIGNATURES,
  postgres: POSTGRES_FUNCTION_SIGNATURES,
  sqlite: SQLITE_FUNCTION_SIGNATURES,
  rqlite: SQLITE_FUNCTION_SIGNATURES,
  turso: SQLITE_FUNCTION_SIGNATURES,
  "cloudflare-d1": CLOUDFLARE_D1_FUNCTION_SIGNATURES,
  sqlserver: SQLSERVER_FUNCTION_SIGNATURES,
  manticoresearch: MANTICORESEARCH_FUNCTION_SIGNATURES,
};

const COMMON_SQL_FUNCTION_NAMES = new Set([
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "CONCAT",
  "SUBSTRING",
  "SUBSTR",
  "REPLACE",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "UPPER",
  "LOWER",
  "LENGTH",
  "EXTRACT",
  "ROUND",
  "FLOOR",
  "CEIL",
  "CEILING",
  "ABS",
  "MOD",
  "POWER",
  "SQRT",
  "SIGN",
  "COALESCE",
  "NULLIF",
  "CAST",
  "GREATEST",
  "LEAST",
]);

const SQL_ALIAS_RESERVED_WORDS = new Set([
  "all",
  "alter",
  "and",
  "any",
  "as",
  "asc",
  "begin",
  "between",
  "by",
  "case",
  "check",
  "commit",
  "constraint",
  "create",
  "cross",
  "default",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "except",
  "exists",
  "for",
  "foreign",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "in",
  "index",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "left",
  "like",
  "limit",
  "natural",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "primary",
  "references",
  "right",
  "rollback",
  "select",
  "set",
  "table",
  "then",
  "to",
  "truncate",
  "union",
  "unique",
  "update",
  "values",
  "view",
  "when",
  "where",
  "with",
]);

const SQL_ALIAS_KEYWORD_WORDS = new Set(sqlAliasKeywordWords(SQL_KEYWORDS.join(" "), StandardSQL.spec.keywords, MySQL.spec.keywords, MariaSQL.spec.keywords, PostgreSQL.spec.keywords, MSSQL.spec.keywords, SQLite.spec.keywords, PLSQL.spec.keywords, Cassandra.spec.keywords));

function sqlAliasKeywordWords(...sources: Array<string | undefined>): string[] {
  return sources
    .flatMap((source) => (source ?? "").split(/\s+/))
    .filter((keyword) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(keyword))
    .map((keyword) => keyword.toLowerCase());
}

export interface SqlCompletionTable {
  name: string;
  schema?: string;
  type?: SqlObjectNavigationType;
  detail?: string;
  applyName?: string;
  boost?: number;
}

export interface SqlCompletionObject {
  name: string;
  schema?: string;
  type: "procedure" | "function" | "trigger" | "package";
  parentSchema?: string;
  parentName?: string;
  dataType?: string;
  signature?: string;
  comment?: string | null;
  applyName?: string;
  boost?: number;
}

export interface SqlCompletionColumn {
  name: string;
  table: string;
  sourceAlias?: string;
  schema?: string;
  dataType?: string;
  isNullable?: boolean;
  comment?: string | null;
}

export interface SqlCompletionForeignKey {
  name: string;
  column: string;
  ref_schema?: string | null;
  ref_table: string;
  ref_column: string;
}

export interface SqlCompletionItem {
  label: string;
  type: "keyword" | "table" | "column" | "snippet" | "function" | "schema";
  detail?: string;
  info?: string;
  apply?: string;
  boost: number;
  exactMatch?: boolean;
  dedupeKey?: string;
}

export function shouldChainSqlCompletionAfterAccept(item: { type?: string; apply?: string }): boolean {
  return item.type === "schema" && item.apply?.endsWith(".") === true;
}

export type SqlKeywordCase = "preserve" | "upper" | "lower";

export interface SqlCompletionReferencedTable {
  name: string;
  schema?: string;
  alias?: string;
  columns?: string[];
  columnAliases?: string[];
}

export type SqlStatementKind = "select" | "insert" | "update" | "delete" | "create" | "alter" | "drop" | "unknown";

export type SqlCompletionContextKind = "table" | "schema" | "catalog" | "routine" | "column" | "alias_column" | "insert_target" | "update_target" | "exec" | "join" | "keyword";

export interface SqlCompletionContext {
  prefix: string;
  qualifier?: string;
  qualifierParts?: string[];
  suggestTables: boolean;
  suggestColumns: boolean;
  suggestKeywords: boolean;
  suggestRoutines: boolean;
  suggestJoinConditions: boolean;
  exclusiveTableSuggestions: boolean;
  exclusiveColumnSuggestions: boolean;
  exclusiveRoutineSuggestions: boolean;
  prioritizeSelectAliases: boolean;
  selectAliases: string[];
  referencedTables: SqlCompletionReferencedTable[];
  insertTable?: string;
  insertSchema?: string;
  statementKind: SqlStatementKind;
  tableTriggerWord?: string;
  isGroupBy: boolean;
  nonAggregatedSelectColumns: string[];
  comparisonLeftColumn?: string;
  onStar: boolean;
  selectListColumnContext: boolean;
  preferredKeywords: string[];
  updateTarget?: { table: string; schema?: string };
  deleteTarget?: { table: string; schema?: string };
  oracleTableFunctionContext?: boolean;
  autoAliasTableCompletions: boolean;
  tableAliasAfterCursor?: boolean;
  contextKind: SqlCompletionContextKind;
}

export interface SqlFunctionSignatureHelp {
  name: string;
  signature: string;
  activeParameter: number;
  parameters: string[];
}

export interface SqlCompletionTranslations {
  nullValue: string;
  isNull: string;
  isNotNull: string;
  stringLiteral: string;
  numericLiteral: string;
  booleanValue: string;
  starExpansionColumns: string;
  functionDescriptions: Record<string, string>;
}

export interface SqlCompletionProviderInput {
  tables: SqlCompletionTable[];
  objects?: SqlCompletionObject[];
  columnsByTable: Map<string, SqlCompletionColumn[]>;
  foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>;
  schemas?: string[];
  translations?: SqlCompletionTranslations;
  snippets?: SqlSnippet[];
  dialect?: "mysql" | "postgres" | "sqlserver";
  databaseType?: DatabaseType;
  currentSchema?: string;
  keywordCase?: SqlKeywordCase;
  autoAliasTables?: boolean;
}

export function buildSqlCompletionItems(
  sql: string,
  cursor: number,
  input: {
    tables: SqlCompletionTable[];
    objects?: SqlCompletionObject[];
    columnsByTable: Map<string, SqlCompletionColumn[]>;
    foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>;
    schemas?: string[];
    translations?: SqlCompletionTranslations;
    dialect?: "mysql" | "postgres" | "sqlserver";
    databaseType?: DatabaseType;
    currentSchema?: string;
    keywordCase?: SqlKeywordCase;
    autoAliasTables?: boolean;
  },
): SqlCompletionItem[] {
  if (isSqlCompletionSuppressedContext(sql, cursor)) return [];
  const context = getSqlCompletionContext(sql, cursor);
  return buildSqlCompletionItemsFromContext(context, input);
}

export function buildSqlCompletionItemsFromContext(context: SqlCompletionContext, input: SqlCompletionProviderInput): SqlCompletionItem[] {
  return new SqlCompletionProvider(context, input).build();
}

class SqlCompletionProvider {
  private readonly items: SqlCompletionItem[] = [];
  private readonly t?: SqlCompletionTranslations;
  private readonly dialect?: "mysql" | "postgres" | "sqlserver";
  private readonly databaseType?: DatabaseType;

  constructor(
    private readonly context: SqlCompletionContext,
    private readonly input: SqlCompletionProviderInput,
  ) {
    this.t = input.translations;
    this.dialect = input.dialect;
    this.databaseType = input.databaseType;
  }

  build(): SqlCompletionItem[] {
    const { context } = this;
    const pendingJoinKeyword = isPendingJoinKeywordContext(context);

    if (this.databaseType === "mongodb") {
      return dedupeAndSort(buildMongoCompletionItemsFromContext({ mode: "root", prefix: context.prefix, from: 0 }).map(mongoCompletionItemToSqlCompletionItem));
    }

    const preferReferencedColumns = hasMatchingReferencedColumnPrefix(context, this.input.columnsByTable);
    if (!pendingJoinKeyword && !context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions) {
      const snippets = this.databaseType === "manticoresearch" ? [...(this.input.snippets ?? DEFAULT_SQL_SNIPPETS), ...MANTICORESEARCH_SQL_SNIPPETS] : (this.input.snippets ?? DEFAULT_SQL_SNIPPETS);
      if (!preferReferencedColumns) {
        this.items.push(...buildSnippetItems(context.prefix, snippets, this.input.keywordCase));
      }
      if (!preferReferencedColumns || context.suggestRoutines) {
        const functionItems = buildFunctionSnippetItems(context.prefix, getFunctionDescriptions(this.t), this.databaseType);
        this.items.push(...(preferReferencedColumns ? functionItems.filter((item) => item.label.toLowerCase().startsWith(context.prefix.toLowerCase())) : functionItems));
        if (isOracleLikeDatabase(this.databaseType)) {
          this.items.push(...buildOracleSystemValueItems(context.prefix, this.input.keywordCase));
        }
      }
    }

    if (this.databaseType === "manticoresearch" && context.exclusiveRoutineSuggestions) {
      this.items.push(
        ...buildSnippetItems(
          context.prefix,
          MANTICORESEARCH_SQL_SNIPPETS.filter((snippet) => snippet.id === "builtin-manticore-call-pq"),
          this.input.keywordCase,
        ),
      );
    }

    if (context.preferredKeywords.length > 0) {
      this.items.push(...buildPreferredKeywordItems(context.prefix, context.preferredKeywords, this.input.keywordCase));
    }

    if (!context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions && context.prioritizeSelectAliases) {
      this.items.push(...buildSelectAliasItems(context));
    }

    if (!context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions && context.isGroupBy && context.nonAggregatedSelectColumns.length > 0) {
      this.items.push(...buildNonAggregatedColumnItems(context, this.input.columnsByTable, this.dialect));
    }

    if (!context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions && context.suggestJoinConditions) {
      this.items.push(...buildJoinConditionItems(context, this.input.columnsByTable, this.input.foreignKeysByTable, this.dialect, this.input.keywordCase));
    }

    if (context.suggestKeywords && !context.exclusiveRoutineSuggestions && !pendingJoinKeyword) {
      this.items.push(...buildJoinModifierKeywordItems(context.prefix, this.input.keywordCase));
      this.items.push(...buildKeywordItems(context.prefix, context, this.databaseType, this.input.keywordCase));
    } else if (shouldOfferKeywordPrefixContinuations(context, pendingJoinKeyword)) {
      this.items.push(...buildKeywordPrefixContinuationItems(context.prefix, context, this.databaseType, this.input.keywordCase));
    }

    if (!context.exclusiveTableSuggestions && context.suggestColumns) {
      this.items.push(...buildColumnItems(context, this.input.columnsByTable, this.dialect));
      this.items.push(...buildSelectAllColumnItems(context, this.input.columnsByTable, this.t, this.dialect));
      this.items.push(...buildInsertAllColumnItems(context, this.input.columnsByTable, this.t, this.dialect));
    }

    const emptyTableNameCompletion = !context.prefix && (context.suggestTables || context.exclusiveTableSuggestions);
    if (!pendingJoinKeyword && !emptyTableNameCompletion && !context.tableAliasAfterCursor && context.referencedTables.length > 0 && !context.suggestColumns && !context.insertTable) {
      this.items.push(...buildAliasItems(context, this.databaseType));
    }

    if (!context.exclusiveColumnSuggestions && context.suggestTables) {
      this.items.push(...buildForeignKeyRelatedTableItems(context, this.input.tables, this.input.foreignKeysByTable, this.dialect));
      this.items.push(...buildTableItems(context, this.input.tables, this.dialect, !!this.input.autoAliasTables && context.autoAliasTableCompletions, context.referencedTables, this.databaseType, this.input.currentSchema));
      if (isOracleLikeDatabase(this.databaseType)) {
        this.items.push(...buildOracleTableFunctionItems(context.prefix));
      }
      if (this.input.schemas && this.input.schemas.length > 0) {
        this.items.push(...buildSchemaItems(context.prefix, this.input.schemas, this.dialect));
      }
    }

    if (context.suggestRoutines || context.exclusiveRoutineSuggestions || context.oracleTableFunctionContext) {
      this.items.push(...buildObjectItems(context, this.input.objects ?? [], this.dialect, this.databaseType, this.input.currentSchema));
    }

    if (context.comparisonLeftColumn && context.suggestKeywords) {
      this.items.push(...buildComparisonValueItems(context, this.input.columnsByTable, this.t, this.input.keywordCase));
    }

    if (context.onStar) {
      const starItem = buildStarExpansionItem(context, this.input.columnsByTable, this.t, this.dialect);
      if (starItem) this.items.push(starItem);
    }

    if (context.prefix) {
      for (const item of this.items) {
        // Alias snippets reuse the prefix as a label while applying alias SQL, so they are not exact name matches.
        const isAliasSnippet = item.type === "snippet" && item.apply === formatAliasCompletionApply(item.label, this.databaseType);
        if (!isAliasSnippet && item.label.toLowerCase() === context.prefix.toLowerCase()) {
          item.exactMatch = true;
          item.boost += EXACT_LABEL_MATCH_BOOST;
        }
      }
    }

    return dedupeAndSort(this.items);
  }
}

export function shouldAutoOpenSqlCompletion(sql: string, cursor: number): boolean {
  if (isSqlCompletionSuppressedContext(sql, cursor)) return false;
  const previousChar = sql[cursor - 1];
  if (!previousChar) return false;
  if (/\bon\s+$/i.test(sql.slice(0, cursor))) return true;
  if (isAfterJoinModifierContext(sql.slice(0, cursor))) return true;
  if (/\bcall\s+(?:[A-Za-z_][\w$]*\.)?$/i.test(sql.slice(0, cursor))) return true;
  const context = getSqlCompletionContext(sql, cursor);
  if (previousChar === "(" && context.insertTable) return true;
  if (/[,;()[\]]/.test(previousChar)) return false;
  if (context.exclusiveTableSuggestions || context.exclusiveRoutineSuggestions || context.suggestTables) {
    return true;
  }
  if (context.exclusiveColumnSuggestions || shouldAutoOpenColumnCompletion(context, sql, cursor)) return true;
  return /[A-Za-z_$@.]/.test(previousChar);
}

function shouldAutoOpenColumnCompletion(context: SqlCompletionContext, sql: string, cursor: number): boolean {
  if (!context.suggestColumns || context.referencedTables.length === 0) return false;
  if (context.prefix.length > 0) return true;
  return isColumnCompletionExpressionStart(sql.slice(0, cursor));
}

function isColumnCompletionExpressionStart(beforeCursor: string): boolean {
  const cleaned = stripSqlLiterals(beforeCursor).trimEnd();
  if (!cleaned) return false;
  return /(?:\b(?:where|on|having|and|or|not|is|like|in|between|by)\b|[,(])$/i.test(cleaned);
}

export function isSqlCompletionSuppressedContext(sql: string, cursor: number): boolean {
  const context = getSqlLexicalContext(sql, cursor);
  return context.inLineComment || context.inBlockComment || context.inStringLiteral;
}

export function isSqlStringLiteralContext(sql: string, cursor: number): boolean {
  return getSqlLexicalContext(sql, cursor).inStringLiteral;
}

export function isSqlCommentContext(sql: string, cursor: number): boolean {
  const context = getSqlLexicalContext(sql, cursor);
  return context.inLineComment || context.inBlockComment;
}

function getSqlLexicalContext(sql: string, cursor: number): { inLineComment: boolean; inBlockComment: boolean; inStringLiteral: boolean } {
  const end = Math.max(0, Math.min(cursor, sql.length));
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < end; index += 1) {
    const ch = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      if (ch === "\\" && next) {
        index += 1;
      } else if (ch === "'" && next === "'") {
        index += 1;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (ch === "\\" && next) {
        index += 1;
      } else if (ch === '"' && next === '"') {
        index += 1;
      } else if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (inBracket) {
      if (ch === "]") inBracket = false;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      index += 1;
    } else if (ch === "#") {
      inLineComment = true;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else if (ch === "'") {
      inSingleQuote = true;
    } else if (ch === '"') {
      inDoubleQuote = true;
    } else if (ch === "`") {
      inBacktick = true;
    } else if (ch === "[") {
      inBracket = true;
    }
  }

  // Only single-quoted text is a value literal here. Double quotes, backticks,
  // and brackets delimit identifiers in common SQL dialects, so they must not
  // suppress identifier completion.
  return {
    inLineComment,
    inBlockComment,
    inStringLiteral: inSingleQuote,
  };
}

export function isSqlLikeCompletionStatement(sql: string, cursor: number): boolean {
  const statement = extractStatementAt(sql, cursor).trimStart();
  if (/^(select|with)\b/i.test(statement)) return true;
  return currentLineBlockStartsSql(sql, cursor);
}

function currentLineBlockStartsSql(sql: string, cursor: number): boolean {
  return currentSqlLikeLineBlockSpan(sql, cursor) != null;
}

function currentSqlLikeLineBlockSpan(sql: string, cursor: number): { start: number; end: number } | null {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  const beforeCursor = sql.slice(0, safeCursor);
  const lines = beforeCursor.split(/\r?\n/);
  let start: number | null = null;
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed) {
      const indentation = line.length - trimmed.length;
      if (/^(select|with)\b/i.test(trimmed)) start = offset + indentation;
      if (/^(get|post|put|delete|patch|head)\s+\//i.test(trimmed)) start = null;
    }
    offset += line.length + 1;
  }

  if (start == null) return null;

  let end = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let index = start; index < sql.length; index += 1) {
    const ch = sql[index];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote && index >= safeCursor) {
      end = index;
      break;
    }
  }

  const blockEnd = currentLineBlockEnd(sql, safeCursor, start);
  if (blockEnd != null) end = Math.min(end, blockEnd);

  return { start, end };
}

function currentLineBlockEnd(sql: string, cursor: number, start: number): number | null {
  let lineStart = sql.lastIndexOf("\n", cursor - 1) + 1;
  while (lineStart < sql.length) {
    const lineEnd = sql.indexOf("\n", lineStart);
    const boundedLineEnd = lineEnd >= 0 ? lineEnd : sql.length;
    const line = sql.slice(lineStart, boundedLineEnd);
    const trimmed = line.trimStart();
    if (lineStart > start && (!trimmed || /^(get|post|put|delete|patch|head)\s+\//i.test(trimmed))) {
      return lineStart;
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

export function getSqlCompletionResultValidFor(sql: string, cursor: number): RegExp | undefined {
  void sql;
  void cursor;
  return undefined;
}

export function getSqlFunctionSignatureHelp(sql: string, cursor: number, databaseType?: DatabaseType): SqlFunctionSignatureHelp | null {
  const beforeCursor = sql.slice(0, cursor);
  const openParenIndex = findActiveFunctionOpenParen(beforeCursor);
  if (openParenIndex == null) return null;

  const beforeParen = beforeCursor.slice(0, openParenIndex).trimEnd();
  const name = /([A-Za-z_][\w$]*)$/.exec(beforeParen)?.[1]?.toUpperCase();
  if (!name) return null;

  const parameters = (databaseType ? DATABASE_FUNCTION_SIGNATURES[databaseType]?.get(name) : undefined) ?? SQL_FUNCTION_SIGNATURES.get(name);
  if (!parameters) return null;

  const activeParameter = countTopLevelCommas(beforeCursor.slice(openParenIndex + 1));
  return {
    name,
    signature: `${name}(${parameters.join(", ")})`,
    activeParameter: Math.min(activeParameter, Math.max(0, parameters.length - 1)),
    parameters,
  };
}

/**
 * Find the start position of the SQL statement containing the cursor.
 * Respects semicolons and string literals.
 */
function extractStatementStart(sql: string, cursor: number): number {
  const lineBlock = currentSqlLikeLineBlockSpan(sql, cursor);
  if (lineBlock) return lineBlock.start;

  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote) {
      if (i < cursor) {
        start = i + 1;
        while (start < sql.length && /\s/.test(sql[start])) start++;
      }
    }
  }
  return start;
}

/**
 * Extract the full SQL statement that contains the cursor position.
 * Respects semicolons and string literals.
 */
function extractStatementAt(sql: string, cursor: number): string {
  const lineBlock = currentSqlLikeLineBlockSpan(sql, cursor);
  if (lineBlock) return sql.slice(lineBlock.start, lineBlock.end).trim();

  const start = extractStatementStart(sql, cursor);
  let end = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote && i >= cursor) {
      end = i;
      break;
    }
  }
  return sql.slice(start, end).trim();
}

function detectStatementKind(previousStatements: string): SqlStatementKind {
  const trimmed = previousStatements.trim();
  if (!trimmed) return "unknown";
  const firstWord = /^([A-Za-z_][\w$]*)/.exec(trimmed)?.[1]?.toLowerCase();
  if (!firstWord) return "unknown";
  const kindMap: Record<string, SqlStatementKind> = {
    select: "select",
    with: "select",
    insert: "insert",
    update: "update",
    delete: "delete",
    create: "create",
    alter: "alter",
    drop: "drop",
  };
  return kindMap[firstWord] ?? "unknown";
}

function isCallRoutineContext(beforeToken: string): boolean {
  return /\bcall\s+(?:[A-Za-z_][\w$]*\.)?$/i.test(beforeToken) || /\bcall\s+(?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*$/i.test(beforeToken);
}

const SQL_IDENTIFIER_CONTINUE_CHAR = /[$_\u200c\u200d\p{ID_Continue}]/u;

function hasTableAliasAfterCursor(sql: string, cursor: number): boolean {
  if (hasAliasMarkerAt(sql, cursor, false)) return true;
  let pos = cursor;
  while (pos < sql.length) {
    const codePoint = sql.codePointAt(pos);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    if (char !== "." && !SQL_IDENTIFIER_CONTINUE_CHAR.test(char)) break;
    // Advance by the full code point so supplementary Unicode identifiers
    // do not leave the scan between UTF-16 surrogate halves.
    pos += char.length;
  }
  if (sql[pos] === '"' || sql[pos] === "`" || sql[pos] === "]") pos++;
  return hasAliasMarkerAt(sql, pos, true);
}

function hasAliasMarkerAt(sql: string, pos: number, allowImplicitAlias: boolean): boolean {
  const following = sql.slice(skipSqlWhitespaceAndComments(sql, pos));
  if (/^as\b/i.test(following)) return true;
  if (/^(?:"[^"]+"|`[^`]+`|\[[^\]]+\])/.test(following)) return true;
  if (!allowImplicitAlias) return false;
  const implicitAlias = /^([A-Za-z_][\w$]*)/.exec(following)?.[1]?.toLowerCase();
  return !!implicitAlias && !isUnsafeSqlAlias(implicitAlias);
}

function skipSqlWhitespaceAndComments(sql: string, pos: number): number {
  for (;;) {
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    if (sql.startsWith("--", pos)) {
      const newline = sql.indexOf("\n", pos + 2);
      if (newline === -1) return sql.length;
      pos = newline + 1;
    } else if (sql.startsWith("/*", pos)) {
      const end = sql.indexOf("*/", pos + 2);
      if (end === -1) return sql.length;
      pos = end + 2;
    } else {
      return pos;
    }
  }
}

export function getSqlCompletionContext(sql: string, cursor: number): SqlCompletionContext {
  // Extract the full statement at cursor position for referenced tables
  const fullStatement = extractStatementAt(sql, cursor);

  // Content before cursor within the current statement
  const stmtStart = extractStatementStart(sql, cursor);
  const beforeCursor = sql.slice(stmtStart, cursor);

  const trailingIdentifier = parseTrailingIdentifierContext(beforeCursor);
  const prefix = trailingIdentifier?.prefix ?? "";
  const qualifier = trailingIdentifier?.qualifier;
  const qualifierParts = trailingIdentifier?.qualifierParts;
  const bareStart = trailingIdentifier?.start ?? beforeCursor.length;
  const beforeToken = beforeCursor.slice(0, Math.max(0, bareStart)).trimEnd();
  const lastWord = /([A-Za-z_][\w$]*)$/.exec(beforeToken)?.[1]?.toLowerCase() ?? "";

  let referencedTables = extractReferencedTables(fullStatement);

  // Merge CTE definitions into referenced tables
  const cteDefs = extractCteDefinitions(fullStatement);
  for (const cte of cteDefs) {
    if (!referencedTables.some((rt) => rt.name.toLowerCase() === cte.name.toLowerCase())) {
      referencedTables.push({ name: cte.name, columns: cte.columns });
    } else {
      const existing = referencedTables.find((rt) => rt.name.toLowerCase() === cte.name.toLowerCase());
      if (existing && !existing.columns) {
        existing.columns = cte.columns;
      }
    }
  }

  // Merge subquery alias references
  const subqueryRefs = extractSubqueryReferences(fullStatement);
  for (const sq of subqueryRefs) {
    if (!referencedTables.some((rt) => rt.name.toLowerCase() === sq.name.toLowerCase() && rt.alias === sq.alias)) {
      referencedTables.push(sq);
    }
  }

  // Detect INSERT INTO table (column list) context
  const insertInfo = detectInsertColumnListContext(beforeCursor);
  const updateInfo = detectUpdateCompletionContext(beforeCursor);
  const deleteInfo = detectDeleteCompletionContext(beforeCursor);
  const oracleTableFunctionContext = detectOracleTableFunctionContext(beforeCursor);

  const afterTableTrigger = TABLE_TRIGGER_KEYWORDS.has(lastWord) || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || isInTableListContext(beforeToken);
  const exclusiveTableSuggestions = EXCLUSIVE_TABLE_TRIGGER_KEYWORDS.has(lastWord) || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || isInTableListContext(beforeToken);
  const tableAliasAfterCursor = hasTableAliasAfterCursor(sql, cursor);
  const autoAliasTableCompletions = (lastWord === "from" || lastWord === "join" || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || isInTableListContext(beforeToken)) && !tableAliasAfterCursor;
  const exclusiveColumnSuggestions = !!qualifier && !exclusiveTableSuggestions && !insertInfo;
  const activePrefixIsCte = cteDefs.some((cte) => normalizeIdentifierPart(cte.name) === normalizeIdentifierPart(prefix));
  if (exclusiveTableSuggestions && prefix && !activePrefixIsCte && referencedTables.length > 1) {
    referencedTables = removeActiveTableCompletionReference(referencedTables, prefix, qualifier);
  }

  // Check if we're in a context where columns are expected
  const selectListColumnContext = isInSelectListContext(beforeCursor);
  const inColumnContext = selectListColumnContext || isInColumnContext(beforeCursor) || !!insertInfo;
  const inJoinConditionContext = isInJoinConditionContext(beforeCursor);
  const prioritizeSelectAliases = isInOrderOrGroupByContext(beforeCursor);
  const inCallRoutineContext = isCallRoutineContext(beforeCursor);
  const inPotentialPackageMemberContext = !!qualifier && !exclusiveTableSuggestions && !insertInfo && !updateInfo?.inSetClause && !oracleTableFunctionContext;
  const suggestColumns = !!qualifier || !!updateInfo?.inSetClause || !!insertInfo || (inColumnContext && referencedTables.length > 0);
  const suggestRoutines = inCallRoutineContext || oracleTableFunctionContext || inPotentialPackageMemberContext || (!exclusiveTableSuggestions && !exclusiveColumnSuggestions && !insertInfo && !updateInfo?.inSetClause && prefix.length >= 2);

  const statementKind = detectStatementKind(beforeCursor || fullStatement);
  const preferredKeywords = qualifier ? [] : preferredKeywordsForCompletion(beforeCursor, beforeToken, selectListColumnContext, exclusiveTableSuggestions, updateInfo, deleteInfo);
  const contextKind = detectCompletionContextKind({
    qualifier,
    exclusiveTableSuggestions,
    exclusiveColumnSuggestions,
    insertInfo,
    updateInfo,
    inCallRoutineContext,
    oracleTableFunctionContext,
    afterTableTrigger,
    lastWord,
    statementKind,
    suggestColumns,
    suggestRoutines,
  });

  return {
    prefix,
    qualifier: insertInfo ? undefined : qualifier,
    qualifierParts: insertInfo ? undefined : qualifierParts,
    suggestTables: insertInfo ? false : afterTableTrigger,
    suggestColumns,
    suggestKeywords: !exclusiveTableSuggestions && !exclusiveColumnSuggestions && !insertInfo && !inCallRoutineContext,
    suggestRoutines,
    suggestJoinConditions: insertInfo ? false : inJoinConditionContext && referencedTables.length >= 2,
    exclusiveTableSuggestions: insertInfo ? false : exclusiveTableSuggestions,
    exclusiveColumnSuggestions: exclusiveColumnSuggestions || !!insertInfo || !!updateInfo?.inSetClause,
    exclusiveRoutineSuggestions: inCallRoutineContext,
    prioritizeSelectAliases: insertInfo ? false : prioritizeSelectAliases,
    selectAliases: prioritizeSelectAliases ? extractSelectAliases(fullStatement) : [],
    referencedTables,
    insertTable: insertInfo?.table,
    insertSchema: insertInfo?.schema,
    statementKind,
    tableTriggerWord: lastWord || undefined,
    isGroupBy: isInGroupByContext(beforeCursor),
    nonAggregatedSelectColumns: extractNonAggregatedSelectColumns(fullStatement),
    comparisonLeftColumn: detectComparisonLeftColumn(beforeCursor),
    onStar: detectOnStar(beforeCursor),
    selectListColumnContext,
    preferredKeywords,
    updateTarget: updateInfo?.target,
    deleteTarget: deleteInfo?.target,
    oracleTableFunctionContext,
    autoAliasTableCompletions,
    tableAliasAfterCursor,
    contextKind,
  };
}

function removeActiveTableCompletionReference(referencedTables: SqlCompletionReferencedTable[], prefix: string, qualifier?: string): SqlCompletionReferencedTable[] {
  const activeName = normalizeIdentifierPart(prefix);
  const activeQualifier = qualifier ? normalizeIdentifierPart(qualifier) : undefined;
  return referencedTables.filter((table) => {
    if (table.alias) return true;
    if (normalizeIdentifierPart(table.name) !== activeName) return true;
    if (activeQualifier && table.schema && normalizeIdentifierPart(table.schema) !== activeQualifier) return true;
    return false;
  });
}

function detectCompletionContextKind(options: {
  qualifier?: string;
  exclusiveTableSuggestions: boolean;
  exclusiveColumnSuggestions: boolean;
  insertInfo: ReturnType<typeof detectInsertColumnListContext>;
  updateInfo: ReturnType<typeof detectUpdateCompletionContext>;
  inCallRoutineContext: boolean;
  oracleTableFunctionContext: boolean;
  afterTableTrigger: boolean;
  lastWord: string;
  statementKind: SqlStatementKind;
  suggestColumns: boolean;
  suggestRoutines: boolean;
}): SqlCompletionContextKind {
  if (options.insertInfo) return "column";
  if (options.updateInfo?.inSetClause) return "column";
  if (options.inCallRoutineContext) return "exec";
  if (options.qualifier && options.exclusiveColumnSuggestions) return "alias_column";
  if (options.suggestColumns) return options.qualifier ? "alias_column" : "column";
  if (options.oracleTableFunctionContext || options.suggestRoutines) return "routine";
  if (options.exclusiveTableSuggestions || options.afterTableTrigger) {
    if (options.statementKind === "insert" && options.lastWord === "into") return "insert_target";
    return options.lastWord === "join" ? "join" : "table";
  }
  return "keyword";
}

function parseTrailingIdentifierContext(input: string): { start: number; prefix: string; qualifier?: string; qualifierParts?: string[] } | null {
  if (/\s$/.test(input)) return null;
  let i = input.length - 1;
  while (i >= 0 && /\s/.test(input[i] ?? "")) i--;
  if (i < 0) return null;

  const endsWithDot = input[i] === ".";
  const tail = input.slice(0, endsWithDot ? i : i + 1);
  if (!tail) {
    return endsWithDot ? { start: i, prefix: "" } : null;
  }
  const parts: string[] = [];
  let index = tail.length;

  while (index > 0) {
    const parsed = parseTrailingIdentifierPart(tail, index);
    if (!parsed) break;
    parts.unshift(unquoteIdentifier(parsed.raw));
    index = parsed.start;
    if (index <= 0 || tail[index - 1] !== ".") break;
    index -= 1;
  }

  if (parts.length === 0) return null;
  const start = index;

  if (parts.length >= 2 || endsWithDot) {
    const qualifierParts = endsWithDot ? parts : parts.slice(0, -1);
    const prefixPart = endsWithDot ? "" : (parts[parts.length - 1] ?? "");
    const qualifierValue = qualifierParts.join(".");
    return {
      start,
      prefix: prefixPart,
      qualifier: qualifierValue || undefined,
      qualifierParts: qualifierParts.length > 0 ? qualifierParts : undefined,
    };
  }

  return {
    start,
    prefix: parts[0] ?? "",
  };
}

function parseTrailingIdentifierPart(input: string, endExclusive: number): { start: number; raw: string } | null {
  if (endExclusive <= 0) return null;
  const end = endExclusive - 1;
  const tailChar = input[end];
  if (!tailChar) return null;

  if (tailChar === '"') {
    let start = end - 1;
    while (start >= 0) {
      if (input[start] === '"') {
        if (start > 0 && input[start - 1] === '"') {
          start -= 2;
          continue;
        }
        return { start, raw: input.slice(start, endExclusive) };
      }
      start -= 1;
    }
    return null;
  }

  if (tailChar === "`") {
    const start = input.lastIndexOf("`", end - 1);
    if (start < 0) return null;
    return { start, raw: input.slice(start, endExclusive) };
  }

  let start = end;
  while (start >= 0 && /[A-Za-z0-9_$@]/.test(input[start] ?? "")) start -= 1;
  start += 1;
  if (start >= endExclusive) return null;
  const raw = input.slice(start, endExclusive);
  if (!/^[@A-Za-z_][\w$@]*$/.test(raw)) return null;
  return { start, raw };
}

/**
 * Check if the content before cursor is in a column-expected context.
 */
function isInColumnContext(beforeCursor: string): boolean {
  if (!beforeCursor) return false;

  if (isInSelectListContext(beforeCursor)) return true;
  if (isInOrderOrGroupByContext(beforeCursor)) return true;

  // Strip string literals
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, "''");

  // Get all words/tokens
  const lastWords = cleaned.trimEnd().split(/\s+/);

  // Check the last 3 words for column-context keywords
  for (let i = lastWords.length - 1; i >= Math.max(0, lastWords.length - 3); i--) {
    const rawWord = lastWords[i]?.toLowerCase() ?? "";
    if (/^[=<>!+\-/(,]$/.test(rawWord)) return true;
    const word = rawWord.replace(/[^a-z0-9.]/g, "");
    // Operators that indicate column context
    // Keywords that directly precede column expressions
    if (["where", "on", "having", "set", "and", "or", "not", "is", "like", "in", "between", "select"].includes(word)) {
      return true;
    }
    // "ORDER BY" / "GROUP BY" — when we see "by", check the word before it
    if (word === "by" && i > 0) {
      const prevWord = lastWords[i - 1]?.toLowerCase() ?? "";
      if (["order", "group"].includes(prevWord)) return true;
    }
  }

  return false;
}

function isInSelectListContext(beforeCursor: string): boolean {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  const selectOpenByDepth = new Map<number, boolean>();

  for (let i = 0; i < beforeCursor.length; i++) {
    const ch = beforeCursor[i] ?? "";
    const next = beforeCursor[i + 1] ?? "";

    if (inSingleQuote) {
      if (ch === "\\" && next) {
        i++;
      } else if (ch === "'" && next === "'") {
        i++;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        i++;
      } else if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      selectOpenByDepth.delete(depth);
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) continue;

    let end = i + 1;
    while (end < beforeCursor.length && /[A-Za-z0-9_$]/.test(beforeCursor[end] ?? "")) end++;
    const word = beforeCursor.slice(i, end).toLowerCase();
    if (word === "select") {
      selectOpenByDepth.set(depth, true);
    } else if (word === "from") {
      selectOpenByDepth.set(depth, false);
    }
    i = end - 1;
  }

  return selectOpenByDepth.get(depth) === true;
}

function isInJoinConditionContext(beforeCursor: string): boolean {
  const cleaned = beforeCursor
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, "''")
    .toLowerCase();
  const lastJoinIndex = cleaned.lastIndexOf(" join ");
  const currentJoinSegment = lastJoinIndex >= 0 ? cleaned.slice(lastJoinIndex) : cleaned;
  if (!/\bon\b/.test(currentJoinSegment)) return false;
  return /\b(?:on|and)\s+[a-z0-9_$]*$/i.test(currentJoinSegment);
}

function isInOrderOrGroupByContext(beforeCursor: string): boolean {
  const cleaned = beforeCursor
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .toLowerCase();
  const lastOrderBy = cleaned.lastIndexOf("order by");
  const lastGroupBy = cleaned.lastIndexOf("group by");
  const lastContext = Math.max(lastOrderBy, lastGroupBy);
  if (lastContext < 0) return false;

  const segment = cleaned.slice(lastContext);
  return !/\b(?:where|having|limit|offset|union|intersect|except|join|from)\b/.test(segment);
}

function isInGroupByContext(beforeCursor: string): boolean {
  const cleaned = beforeCursor
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .toLowerCase();
  const lastGroupBy = cleaned.lastIndexOf("group by");
  if (lastGroupBy < 0) return false;
  // Make sure GROUP BY is after ORDER BY (if both exist) — we want the closest
  const lastOrderBy = cleaned.lastIndexOf("order by");
  if (lastOrderBy > lastGroupBy) return false;
  const segment = cleaned.slice(lastGroupBy);
  return !/\b(?:where|having|limit|offset|union|intersect|except|join|from)\b/.test(segment);
}

const AGGREGATE_FUNCTION_PATTERN = /^(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|STRING_AGG|ARRAY_AGG|JSON_ARRAYAGG|JSON_OBJECTAGG)\s*\(/i;

function extractNonAggregatedSelectColumns(sql: string): string[] {
  const selectList = extractSelectList(sql);
  if (!selectList) return [];

  const columns: string[] = [];
  for (const expression of splitTopLevel(selectList, ",")) {
    const trimmed = expression.trim();
    if (trimmed === "*") continue;
    if (AGGREGATE_FUNCTION_PATTERN.test(trimmed)) continue;

    const alias = /\bas\s+([A-Za-z_][\w$]*)$/i.exec(trimmed)?.[1];
    if (alias) {
      columns.push(alias);
      continue;
    }

    const lastId = /([A-Za-z_][\w$]*)$/.exec(trimmed)?.[1];
    if (lastId) columns.push(lastId);
  }

  return columns;
}

function detectOnStar(beforeCursor: string): boolean {
  // Cursor is right after * in SELECT clause
  return /\bselect\b[^;]*\*$/i.test(beforeCursor);
}

function detectComparisonLeftColumn(beforeCursor: string): string | undefined {
  // Match: column_name = | column.column = | alias.column =
  const match = /\b([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:=|!=|<>|>=|<=|>|<)\s*$/i.exec(beforeCursor);
  return match?.[1];
}

function detectInsertColumnListContext(beforeCursor: string): { table: string; schema?: string } | null {
  // Keep quoted identifiers intact so schema/table targets resolve to their
  // real names instead of placeholder string contents.
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''");
  const identifier = '(?:"[^"]+"|`[^`]+`|[A-Za-z_][\\w$]*)';
  const qualifiedIdentifier = `${identifier}(?:\\.${identifier}){0,2}`;
  const match = new RegExp(`\\binsert\\s+into\\s+(${qualifiedIdentifier})\\s*\\([^)]*$`, "i").exec(cleaned);
  if (!match) return null;
  const fullTable = match[1];
  if (!fullTable) return null;
  const [first, second] = splitQualifiedName(fullTable);
  if (second) return { table: second, schema: first! };
  return { table: first! };
}

function detectUpdateCompletionContext(beforeCursor: string): { target: { table: string; schema?: string }; afterTarget: boolean; inSetClause: boolean; afterSetAssignments: boolean } | null {
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const match = /^\s*update\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?((?!set\b|where\b)[A-Za-z_][\w$]*))?/i.exec(cleaned);
  if (!match) return null;
  const [first, second] = splitQualifiedName(match[1] ?? "");
  if (!first) return null;
  const target = second ? { schema: first, table: second } : { table: first };
  const afterTargetText = cleaned.slice(match[0].length).trimStart();
  const afterTarget = !afterTargetText || /^[A-Za-z_][\w$]*$/i.test(afterTargetText);
  const setIndex = afterTargetText.search(/\bset\b/i);
  if (setIndex < 0) return { target, afterTarget, inSetClause: false, afterSetAssignments: false };
  const setSegment = afterTargetText.slice(setIndex + 3);
  const inSetClause = !/\bwhere\b/i.test(setSegment);
  const afterSetAssignments = inSetClause && /(?:=|,)\s*(?:''|""|[A-Za-z0-9_.$]+)?\s+[A-Za-z_][\w$]*$/i.test(setSegment);
  return { target, afterTarget: false, inSetClause, afterSetAssignments };
}

function detectDeleteCompletionContext(beforeCursor: string): { target?: { table: string; schema?: string }; afterTarget: boolean } | null {
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const match = /^\s*delete(?:\s+[A-Za-z_][\w$]*)?\s+from\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/i.exec(cleaned);
  if (!match) return /^\s*delete\s+(?:from\s+)?[A-Za-z_][\w$]*$/i.test(cleaned) ? { afterTarget: false } : null;
  const [first, second] = splitQualifiedName(match[1] ?? "");
  const target = first ? (second ? { schema: first, table: second } : { table: first }) : undefined;
  const afterTargetText = cleaned.slice(match[0].length).trimStart();
  return { target, afterTarget: !afterTargetText || /^[A-Za-z_][\w$]*$/i.test(afterTargetText) };
}

function detectOracleTableFunctionContext(beforeCursor: string): boolean {
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return /\b(?:from|join)\s+table\s*\(\s*(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\.){0,2}[A-Za-z_][\w$]*$/i.test(cleaned);
}

function preferredKeywordsForCompletion(beforeCursor: string, beforeToken: string, selectListColumnContext: boolean, exclusiveTableSuggestions: boolean, updateInfo: ReturnType<typeof detectUpdateCompletionContext>, deleteInfo: ReturnType<typeof detectDeleteCompletionContext>): string[] {
  const keywords: string[] = [];
  if (selectListColumnContext && hasSelectListExpression(beforeCursor)) keywords.push("FROM");
  if (isAfterJoinModifierContext(beforeCursor)) keywords.push("JOIN");
  if (!exclusiveTableSuggestions && isAfterSelectBodyExpression(beforeToken)) keywords.push("LIMIT");
  if (isAfterConditionExpression(beforeToken)) keywords.push("AND", "OR");
  if (updateInfo?.afterTarget) keywords.push("SET");
  if (updateInfo?.afterSetAssignments) keywords.push("WHERE");
  if (deleteInfo?.afterTarget) keywords.push("WHERE");
  return keywords;
}

function hasSelectListExpression(beforeCursor: string): boolean {
  const cleaned = stripSqlLiterals(beforeCursor).trimEnd();
  const selectIndex = lastTopLevelKeywordIndex(cleaned, "select");
  if (selectIndex < 0) return false;
  const afterSelect = cleaned.slice(selectIndex + "select".length).trim();
  return !!afterSelect && !/^distinct\s*$/i.test(afterSelect);
}

function isAfterSelectBodyExpression(beforeToken: string): boolean {
  const cleaned = stripSqlLiterals(beforeToken).trimEnd();
  if (!/^\s*(?:with\b[\s\S]*\bselect\b|select\b)/i.test(cleaned)) return false;
  if (!/\bfrom\b/i.test(cleaned)) return false;
  if (/\b(?:limit|offset|union|intersect|except)\b/i.test(cleaned)) return false;
  if (/[,.(+\-*/%<>=!&|]$/.test(cleaned)) return false;
  const lastKeyword = /\b([A-Za-z_][\w$]*)\s*$/.exec(cleaned)?.[1]?.toLowerCase();
  if (lastKeyword && SELECT_BODY_INCOMPLETE_TAIL_KEYWORDS.has(lastKeyword)) return false;
  return true;
}

const SELECT_BODY_INCOMPLETE_TAIL_KEYWORDS = new Set(["where", "and", "or", "not", "having", "group", "order", "by", "on", "is", "in", "like", "between", ...JOIN_MODIFIERS]);
const CONDITION_INCOMPLETE_TAIL_KEYWORDS = new Set(["where", "and", "or", "not", "having", "on", "is", "in", "like", "between", "exists"]);

function isAfterConditionExpression(beforeToken: string): boolean {
  const cleaned = stripSqlLiterals(beforeToken).trimEnd();
  if (!hasActiveConditionClause(cleaned)) return false;
  const lastKeyword = /\b([A-Za-z_][\w$]*)\s*$/.exec(cleaned)?.[1]?.toLowerCase();
  if (lastKeyword && CONDITION_INCOMPLETE_TAIL_KEYWORDS.has(lastKeyword)) return false;
  return isExpressionTailComplete(cleaned);
}

function isAfterJoinModifierContext(beforeCursor: string): boolean {
  const cleaned = stripSqlLiterals(beforeCursor).trimEnd();
  const modifier = /\b([A-Za-z_][\w$]*)\s*$/.exec(cleaned)?.[1]?.toLowerCase();
  if (!modifier || !JOIN_MODIFIERS.has(modifier)) return false;

  const beforeModifier = cleaned.slice(0, cleaned.length - modifier.length).trimEnd();
  const lastTableIntro = Math.max(lastTopLevelKeywordIndex(beforeModifier, "from"), lastTopLevelKeywordIndex(beforeModifier, "join"));
  if (lastTableIntro < 0) return false;

  const lastClauseBoundary = Math.max(
    lastTopLevelKeywordIndex(beforeModifier, "where"),
    lastTopLevelKeywordIndex(beforeModifier, "group"),
    lastTopLevelKeywordIndex(beforeModifier, "order"),
    lastTopLevelKeywordIndex(beforeModifier, "having"),
    lastTopLevelKeywordIndex(beforeModifier, "limit"),
    lastTopLevelKeywordIndex(beforeModifier, "offset"),
    lastTopLevelKeywordIndex(beforeModifier, "union"),
    lastTopLevelKeywordIndex(beforeModifier, "intersect"),
    lastTopLevelKeywordIndex(beforeModifier, "except"),
  );
  if (lastClauseBoundary > lastTableIntro) return false;

  const tableSegment = beforeModifier
    .slice(lastTableIntro)
    .replace(/^\s*(?:from|join)\b/i, "")
    .trim();
  return tableSegment.length > 0;
}

function hasActiveConditionClause(sql: string): boolean {
  const lower = sql.toLowerCase();
  const whereIndex = lastTopLevelKeywordIndex(lower, "where");
  const havingIndex = lastTopLevelKeywordIndex(lower, "having");
  const onIndex = lastTopLevelKeywordIndex(lower, "on");
  const conditionIndex = Math.max(whereIndex, havingIndex, onIndex);
  if (conditionIndex < 0) return false;
  const afterCondition = lower.slice(conditionIndex);
  return !/\b(?:group\s+by|order\s+by|limit|offset|union|intersect|except)\b/.test(afterCondition);
}

function isExpressionTailComplete(sql: string): boolean {
  const trimmed = sql.trimEnd();
  if (!trimmed) return false;
  const lastChar = trimmed[trimmed.length - 1] ?? "";
  if (/[,.(+\-*/%<>=!&|]$/.test(lastChar)) return false;
  return /(?:\)|\]|\b(?:true|false|null)\b|`[^`]+`|"[^"]*"|''|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w$]*\b)$/i.test(trimmed);
}

function stripSqlLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function lastTopLevelKeywordIndex(sql: string, keyword: string): number {
  const lower = sql.toLowerCase();
  const target = keyword.toLowerCase();
  let depth = 0;
  let lastIndex = -1;
  for (let index = 0; index < lower.length; index++) {
    const ch = lower[index] ?? "";
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && lower.startsWith(target, index) && !isIdentifierPart(lower[index - 1]) && !isIdentifierPart(lower[index + target.length])) {
      lastIndex = index;
      index += target.length - 1;
    }
  }
  return lastIndex;
}

function extractReferencedTables(sql: string): SqlCompletionReferencedTable[] {
  // Keywords that should NOT be treated as table aliases
  const ALIAS_BLACKLIST = new Set([
    "where",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "and",
    "or",
    "not",
    "is",
    "like",
    "in",
    "between",
    "exists",
    "select",
    "from",
    "join",
    "straight_join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "apply",
    "full",
    "natural",
    "on",
    "as",
    "set",
    "insert",
    "update",
    "delete",
    "create",
    "drop",
    "alter",
    "into",
    "values",
    "returning",
    "for",
    "window",
    "partition",
    "over",
    "with",
    "recursive",
    "lateral",
    "when",
    "then",
    "else",
    "end",
    "case",
    "cast",
    "coalesce",
    "null",
    "true",
    "false",
    "distinct",
    "all",
    "primary",
    "key",
    "foreign",
    "references",
    "constraint",
    "default",
    "check",
    "unique",
    "index",
    "table",
    "view",
    "database",
    "schema",
    "describe",
    "explain",
    "analyze",
    "pivot",
    "unpivot",
    "asof",
    "positional",
    "anti",
    "semi",
    "sample",
    "filter",
    "qualify",
    "offset",
    "fetch",
    "next",
    "rows",
    "only",
    "preceding",
    "following",
    "current",
    "unbounded",
    "asc",
    "desc",
    "nulls",
    "first",
    "last",
    "ignore",
    "respect",
  ]);

  // STRAIGHT_JOIN is a standalone MySQL table introducer, not a modifier followed by JOIN.
  const pattern = /\b(?:from|join|straight_join|update|apply)\s+((?:"[^"]+"|`[^`]+`|[^\s,;()]+)(?:\.(?:"[^"]+"|`[^`]+`|[^\s,;()]+))?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  const referenced: SqlCompletionReferencedTable[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const rawName = match[1];
    const alias = match[2];
    if (alias && ALIAS_BLACKLIST.has(alias.toLowerCase())) {
      pattern.lastIndex = match.index + match[0].length - alias.length;
    }
    const quotedName = !!rawName && (rawName.startsWith('"') || rawName.startsWith("`"));
    if (!quotedName && rawName && ALIAS_BLACKLIST.has(rawName.toLowerCase())) continue;
    // Filter out SQL keywords that accidentally matched as aliases
    const cleanAlias = alias && !ALIAS_BLACKLIST.has(alias.toLowerCase()) ? alias : undefined;
    if (isElasticsearchStyleIndexName(rawName)) {
      referenced.push({ name: unquoteIdentifier(rawName), alias: cleanAlias });
      continue;
    }
    const [first, second] = splitQualifiedName(rawName);
    if (!first) continue;
    const table = second ? { schema: first, name: second, alias: cleanAlias } : { name: first, alias: cleanAlias };
    referenced.push(table);
  }
  return referenced;
}

function isElasticsearchStyleIndexName(name: string | undefined): name is string {
  if (!name) return false;
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("`") && name.endsWith("`"))) return false;
  return /[-*]/.test(name);
}

function extractSelectAliases(sql: string): string[] {
  const selectList = extractSelectList(sql);
  if (!selectList) return [];

  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const expression of splitTopLevel(selectList, ",")) {
    const alias = extractSelectAlias(expression);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }

  return aliases;
}

function extractSelectList(sql: string): string | null {
  const lower = sql.toLowerCase();
  const selectIndex = lower.search(/\bselect\b/);
  if (selectIndex < 0) return null;

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = selectIndex + "select".length; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && lower.slice(i, i + "from".length) === "from" && !isIdentifierPart(sql[i - 1]) && !isIdentifierPart(sql[i + "from".length])) {
      return sql.slice(selectIndex + "select".length, i).trim();
    }
  }

  return null;
}

function extractSelectAlias(expression: string): string | null {
  const trimmed = expression.trim();
  const explicitAlias = /\bas\s+([A-Za-z_][\w$]*)$/i.exec(trimmed)?.[1];
  if (explicitAlias) return explicitAlias;

  const implicitAlias = /(?:^|[\s)])([A-Za-z_][\w$]*)$/.exec(trimmed)?.[1];
  if (!implicitAlias) return null;
  const expressionWithoutAlias = trimmed.slice(0, trimmed.length - implicitAlias.length).trimEnd();
  if (!expressionWithoutAlias || /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(trimmed)) return null;
  return implicitAlias;
}

function isIdentifierPart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

function findMatchingParen(sql: string, openPos: number): number {
  if (sql[openPos] !== "(") return -1;
  let depth = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = openPos + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractSelectColumnNames(sql: string): string[] {
  const selectList = extractSelectList(sql);
  if (!selectList) return [];
  const names: string[] = [];
  for (const expression of splitTopLevel(selectList, ",")) {
    const trimmed = expression.trim();
    if (trimmed === "*") continue;
    if (/^[A-Za-z_][\w$]*$/.test(trimmed)) {
      names.push(trimmed);
      continue;
    }
    const alias = /\bas\s+([A-Za-z_][\w$]*)$/i.exec(trimmed)?.[1];
    if (alias) {
      names.push(alias);
      continue;
    }
    const lastId = /([A-Za-z_][\w$]*)$/.exec(trimmed)?.[1];
    if (lastId) names.push(lastId);
  }
  return names;
}

export function extractCteDefinitions(sql: string): Array<{ name: string; columns: string[] }> {
  const ctes: Array<{ name: string; columns: string[] }> = [];
  let lower = sql.toLowerCase();
  const withMatch = /\bwith\b/.exec(lower);
  if (!withMatch) return ctes;

  let pos = withMatch.index + "with".length;
  lower = lower.slice(pos);
  const recursiveMatch = /^\s+recursive\b/.exec(lower);
  if (recursiveMatch) {
    pos += recursiveMatch[0].length;
  }

  while (pos < sql.length) {
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    if (pos >= sql.length) break;
    if (sql[pos] === "," || sql[pos] === ";") {
      pos++;
      continue;
    }

    const remaining = sql.slice(pos);
    const nameMatch = /^([A-Za-z_][\w$]*)/.exec(remaining);
    if (!nameMatch) break;
    const cteName = nameMatch[1];
    pos += nameMatch[0].length;

    while (pos < sql.length && /\s/.test(sql[pos])) pos++;

    let columns: string[] = [];
    if (pos < sql.length && sql[pos] === "(") {
      const colListEnd = findMatchingParen(sql, pos);
      if (colListEnd !== -1) {
        const colList = sql.slice(pos + 1, colListEnd).trim();
        if (!/\bselect\b/i.test(colList)) {
          columns = colList
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          pos = colListEnd + 1;
          while (pos < sql.length && /\s/.test(sql[pos])) pos++;
        }
      }
    }

    while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    if (/\bas\b/i.test(sql.slice(pos, pos + 5))) {
      pos += 2;
      while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    }

    if (pos >= sql.length || sql[pos] !== "(") break;
    const bodyEnd = findMatchingParen(sql, pos);
    if (bodyEnd === -1) break;

    if (columns.length === 0) {
      const body = sql.slice(pos + 1, bodyEnd);
      columns = extractSelectColumnNames(body);
    }

    ctes.push({ name: cteName, columns });
    pos = bodyEnd + 1;
  }

  return ctes;
}

function extractSubqueryReferences(sql: string): SqlCompletionReferencedTable[] {
  const refs: SqlCompletionReferencedTable[] = [];
  const pattern = /\b(?:from|join)\s*\(/gi;

  for (const match of sql.matchAll(pattern)) {
    const openParen = match.index! + match[0].length - 1;
    const closeParen = findMatchingParen(sql, openParen);
    if (closeParen === -1) continue;

    // Extract alias after closing paren
    let pos = closeParen + 1;
    while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    if (/\bas\b/i.test(sql.slice(pos, pos + 4))) {
      pos += 2;
      while (pos < sql.length && /\s/.test(sql[pos])) pos++;
    }
    const aliasMatch = /^([A-Za-z_][\w$]*)/.exec(sql.slice(pos));
    if (!aliasMatch) continue;
    const alias = aliasMatch[1];
    if (ALIAS_BLACKLIST_FOR_REF.has(alias.toLowerCase())) continue;

    // Extract SELECT columns from subquery body
    const body = sql.slice(openParen + 1, closeParen);
    const columns = extractSelectColumnNames(body);

    refs.push({ name: alias, alias, columns });
  }

  return refs;
}

const ALIAS_BLACKLIST_FOR_REF = new Set(["where", "group", "order", "having", "limit", "offset", "union", "intersect", "except", "and", "or", "not", "is", "like", "in", "between", "exists", "select", "on", "set", "left", "right", "inner", "outer", "cross", "full", "natural", "join"]);

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function splitQualifiedName(input: string): [string | undefined, string | undefined] {
  const parts: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (ch === "`" && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    if (ch === "." && !inDoubleQuote && !inBacktick) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  const unquoted = parts.map((p) => unquoteIdentifier(p)).filter(Boolean);
  // For three-part names, the completion model can carry schema.table today;
  // keep the table as the final segment instead of accidentally using catalog.schema.
  if (unquoted.length >= 2) return [unquoted[unquoted.length - 2], unquoted[unquoted.length - 1]];
  return [unquoted[0], undefined];
}

function unquoteIdentifier(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("`") && value.endsWith("`"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function quoteSqlIdentifier(identifier: string, dialect?: "mysql" | "postgres" | "sqlserver"): string {
  if (dialect !== "postgres" || !requiresPostgresIdentifierQuote(identifier)) return identifier;
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requiresPostgresIdentifierQuote(identifier: string): boolean {
  if (!/^[a-z_][a-z0-9_$]*$/.test(identifier)) return true;
  return POSTGRES_IDENTIFIER_KEYWORDS.has(identifier);
}

// PostgreSQL reserved_keyword + type_func_name_keyword categories (pg_get_keywords()
// catcodes R and T) — identifiers matching these cannot appear as a bare column
// reference and must be quoted. SQL_KEYWORDS alone misses most of them because it is
// a completion phrase list ("ORDER BY", not "order").
const POSTGRES_RESERVED_KEYWORDS = [
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "authorization",
  "binary",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "collation",
  "column",
  "concurrently",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "freeze",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "lateral",
  "leading",
  "left",
  "like",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "notnull",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "right",
  "select",
  "session_user",
  "similar",
  "some",
  "symmetric",
  "system_user",
  "table",
  "tablesample",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
];

const POSTGRES_IDENTIFIER_KEYWORDS = new Set(SQL_KEYWORDS.map((keyword) => keyword.toLowerCase()).concat(POSTGRES_RESERVED_KEYWORDS));

function buildTableItems(
  context: Pick<SqlCompletionContext, "prefix" | "qualifier">,
  tables: SqlCompletionTable[],
  dialect?: "mysql" | "postgres" | "sqlserver",
  autoAliasTables = false,
  referencedTables: SqlCompletionReferencedTable[] = [],
  databaseType?: DatabaseType,
  currentSchema?: string,
): SqlCompletionItem[] {
  const { prefix } = context;
  const qualifierSchema = context.qualifier?.split(".").filter(Boolean).pop();
  const existingAliases = new Set(referencedTables.map((ref) => ref.alias?.toLowerCase()).filter((alias): alias is string => !!alias));
  return tables
    .filter((table) => matchesPrefix(table.name, prefix))
    .map((table) => {
      const qualifiedByContext = !!qualifierSchema && !!table.schema && normalizeIdentifierPart(qualifierSchema) === normalizeIdentifierPart(table.schema);
      const oracleSchemaQualification = databaseType === "oracle" && table.schema && table.schema.toUpperCase() !== "PUBLIC" && (!currentSchema || normalizeIdentifierPart(table.schema) !== normalizeIdentifierPart(currentSchema));
      const defaultApplyName = oracleSchemaQualification ? `${quoteSqlIdentifier(table.schema!, dialect)}.${quoteSqlIdentifier(table.name, dialect)}` : quoteSqlIdentifier(table.name, dialect);
      const applyName = qualifiedByContext ? quoteSqlIdentifier(table.name, dialect) : (table.applyName ?? defaultApplyName);
      const alias = autoAliasTables ? generateTableCompletionAlias(table.name, existingAliases) : "";
      return {
        label: table.name,
        type: "table" as const,
        detail: table.detail ?? (table.schema ? `${table.schema}.${table.name}` : table.type),
        apply: formatTableAliasApply(applyName, alias, databaseType),
        boost: computeBoost(table.name, prefix) + 1000 + (table.boost ?? 0),
        dedupeKey: table.applyName || (databaseType === "oracle" && table.schema) ? applyName : undefined,
      };
    })
    .sort(compareCompletionItems)
    .slice(0, MAX_TABLE_COMPLETION_ITEMS);
}

function buildForeignKeyRelatedTableItems(context: SqlCompletionContext, tables: SqlCompletionTable[], foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  if (!foreignKeysByTable || context.referencedTables.length === 0) return [];
  const candidates = new Map<string, { table: SqlCompletionTable; detail: string }>();
  for (const ref of context.referencedTables) {
    for (const [ownerKey, foreignKeys] of foreignKeysByTable.entries()) {
      const owner = foreignKeyOwnerFromKey(ownerKey);
      for (const foreignKey of foreignKeys) {
        if (referencedTableMatchesName(ref, owner.name, owner.schema)) {
          const target = findCompletionTable(tables, foreignKey.ref_table, foreignKey.ref_schema);
          if (target && matchesPrefix(target.name, context.prefix)) {
            candidates.set(`${target.schema ?? ""}.${target.name}`.toLowerCase(), { table: target, detail: `related by ${foreignKey.column} → ${qualifiedCompletionName(foreignKey.ref_table, foreignKey.ref_schema)}.${foreignKey.ref_column}` });
          }
        } else if (referencedTableMatchesName(ref, foreignKey.ref_table, foreignKey.ref_schema)) {
          const target = findCompletionTable(tables, owner.name, owner.schema);
          if (target && matchesPrefix(target.name, context.prefix)) {
            candidates.set(`${target.schema ?? ""}.${target.name}`.toLowerCase(), { table: target, detail: `related by ${qualifiedCompletionName(owner.name, owner.schema)}.${foreignKey.column} → ${foreignKey.ref_column}` });
          }
        }
      }
    }
  }

  return [...candidates.values()]
    .map(({ table, detail }) => ({
      label: table.name,
      type: "table" as const,
      detail,
      apply: quoteSqlIdentifier(table.name, dialect),
      boost: computeBoost(table.name, context.prefix) + 3600,
    }))
    .sort(compareCompletionItems);
}

function foreignKeyOwnerFromKey(ownerKey: string): { name: string; schema?: string } {
  const parts = ownerKey.split(".").filter(Boolean);
  const name = parts.pop() ?? ownerKey;
  const schema = parts.pop();
  return { name, schema };
}

function qualifiedCompletionName(name: string, schema?: string | null): string {
  return schema ? `${schema}.${name}` : name;
}

function findCompletionTable(tables: SqlCompletionTable[], name: string, schema?: string | null): SqlCompletionTable | undefined {
  const normalizedName = normalizeIdentifierPart(name);
  const normalizedSchema = schema ? normalizeIdentifierPart(schema) : undefined;
  return tables.find((table) => normalizeIdentifierPart(table.name) === normalizedName && (!normalizedSchema || !table.schema || normalizeIdentifierPart(table.schema) === normalizedSchema));
}

function buildSchemaItems(prefix: string, schemas: string[], dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  return schemas
    .filter((schema) => matchesPrefix(schema, prefix))
    .slice(0, 50)
    .map((schema) => ({
      label: schema,
      type: "schema" as const,
      detail: "schema",
      apply: `${quoteSqlIdentifier(schema, dialect)}.`,
      boost: computeBoost(schema, prefix) + 700,
    }));
}

function buildObjectItems(context: SqlCompletionContext, objects: SqlCompletionObject[], dialect?: "mysql" | "postgres" | "sqlserver", databaseType?: DatabaseType, currentSchema?: string): SqlCompletionItem[] {
  if (completionQualifierIsReferencedTable(context)) return [];
  const onlyProcedures = context.contextKind === "exec";
  const onlyFunctions = context.suggestColumns && context.referencedTables.length > 0 && !context.qualifier;
  const prioritizeOracleFunctions = databaseType === "oracle" && context.statementKind === "select";
  return objects
    .filter((object) => (!onlyProcedures || object.type === "procedure") && (!onlyFunctions || (object.type === "function" && object.name.toLowerCase().startsWith(context.prefix.toLowerCase()))) && objectMatchesCompletionContext(object, context))
    .map((object) => {
      const qualifiedByContext = objectIsQualifiedByContext(object, context);
      const objectInCurrentSchema = !!currentSchema && !!object.schema && normalizeIdentifierPart(object.schema) === normalizeIdentifierPart(currentSchema);
      const applyName =
        qualifiedByContext || (context.qualifier && object.schema?.toLowerCase() === context.qualifier.toLowerCase())
          ? quoteSqlIdentifier(object.name, dialect)
          : (object.applyName ?? (object.schema && !objectInCurrentSchema ? `${quoteSqlIdentifier(object.schema, dialect)}.${quoteSqlIdentifier(object.name, dialect)}` : quoteSqlIdentifier(object.name, dialect)));
      const locationDetail = object.type === "trigger" && object.parentName ? `trigger on ${object.parentName}` : object.parentName ? `${object.type} in ${object.parentName}` : object.schema ? `${object.type} in ${object.schema}` : object.type;
      const detail = object.dataType ? `${locationDetail}  [${object.dataType}]` : locationDetail;
      const schemaBoost = onlyFunctions ? Math.min(object.boost ?? 0, 1000) : (object.boost ?? 0);
      const typeBoost = routineTypeBoost(object.type, prioritizeOracleFunctions && !onlyFunctions);
      return {
        label: object.name,
        type: "function" as const,
        detail,
        info: buildRoutineInfo(object),
        apply: object.type === "trigger" || object.type === "package" ? applyName : `${applyName}()`,
        boost: computeBoost(object.name, context.prefix) + typeBoost + schemaBoost,
        dedupeKey: object.applyName || (databaseType === "oracle" && object.schema) ? applyName : undefined,
        // Preserve exact routine matches before the capped candidate list is truncated.
        exactMatch: !!context.prefix && object.name.toLowerCase() === context.prefix.toLowerCase(),
      };
    })
    .sort(compareCompletionItems)
    .slice(0, MAX_TABLE_COMPLETION_ITEMS);
}

function buildRoutineInfo(object: SqlCompletionObject): string | undefined {
  const qualifiedName = object.parentName ? [object.parentSchema ?? object.schema, object.parentName, object.name].filter(Boolean).join(".") : [object.schema, object.name].filter(Boolean).join(".");
  const parts = [qualifiedName || object.name, object.signature?.trim(), object.comment?.trim()].filter((part): part is string => !!part);
  return parts.length > 1 ? parts.join("\n") : undefined;
}

function routineTypeBoost(type: SqlCompletionObject["type"], prioritizeFunctions: boolean): number {
  if (type === "package") return 1600;
  if (type === "function") return prioritizeFunctions ? 1800 : 900;
  return prioritizeFunctions ? 900 : 1800;
}

function completionQualifierIsReferencedTable(context: SqlCompletionContext): boolean {
  if (!context.qualifier) return false;
  const qualifier = context.qualifier;
  const qualifierLower = qualifier.toLowerCase();
  const qualifiedTarget = qualifiedTableTargetFromContext(context);
  return context.referencedTables.some((table) => referencedTableMatchesColumnQualifier(table, qualifier, qualifierLower, qualifiedTarget));
}

function objectIsQualifiedByContext(object: SqlCompletionObject, context: SqlCompletionContext): boolean {
  if (!context.qualifier || !object.parentName) return false;
  const qualifier = context.qualifier.toLowerCase();
  const qualifierParts = qualifier.split(".").filter(Boolean);
  const qualifierSchema = qualifierParts.length > 1 ? qualifierParts[qualifierParts.length - 2] : undefined;
  const qualifierPackage = qualifierParts[qualifierParts.length - 1];
  return object.parentName.toLowerCase() === qualifier || (!!qualifierPackage && object.parentName.toLowerCase() === qualifierPackage && (!qualifierSchema || !object.parentSchema || object.parentSchema.toLowerCase() === qualifierSchema));
}

function objectMatchesCompletionContext(object: SqlCompletionObject, context: SqlCompletionContext): boolean {
  if (context.oracleTableFunctionContext && object.type !== "function") return false;
  if (context.qualifier) {
    const qualifier = context.qualifier.toLowerCase();
    const qualifierParts = qualifier.split(".").filter(Boolean);
    const qualifierSchema = qualifierParts.length > 1 ? qualifierParts[qualifierParts.length - 2] : undefined;
    const qualifierPackage = qualifierParts[qualifierParts.length - 1];
    if (object.parentName && object.parentName.toLowerCase() === qualifier) return matchesPrefix(object.name, context.prefix);
    if (object.parentName && qualifierPackage && object.parentName.toLowerCase() === qualifierPackage && (!qualifierSchema || !object.parentSchema || object.parentSchema.toLowerCase() === qualifierSchema)) return matchesPrefix(object.name, context.prefix);
    if (object.schema && object.schema.toLowerCase() === qualifier) return matchesPrefix(object.name, context.prefix);
    if (object.parentSchema && `${object.parentSchema}.${object.parentName ?? ""}`.toLowerCase() === qualifier) return matchesPrefix(object.name, context.prefix);
  }
  return matchesPrefix(object.name, context.prefix);
}

function buildOracleTableFunctionItems(prefix: string): SqlCompletionItem[] {
  const items = [
    { label: "TABLE", detail: "Oracle table function", apply: "TABLE(${function_call})" },
    { label: "THE", detail: "Oracle nested-table expression", apply: "THE(${subquery})" },
    { label: "XMLTABLE", detail: "XML to relational rows", apply: "XMLTABLE(${xpath})" },
    { label: "JSON_TABLE", detail: "JSON to relational rows", apply: "JSON_TABLE(${expr}, ${path})" },
  ];
  return items
    .filter((item) => matchesPrefix(item.label, prefix))
    .map((item) => ({
      ...item,
      type: "function" as const,
      boost: computeBoost(item.label, prefix) + 600,
    }));
}

function applySqlKeywordCase(value: string, keywordCase?: SqlKeywordCase): string {
  if (keywordCase === "lower") return value.toLowerCase();
  return value.toUpperCase();
}

function keywordJoiner(keywordCase?: SqlKeywordCase): string {
  return keywordCase === "lower" ? " and " : " AND ";
}

function shouldFormatBuiltinSnippet(snippet: SqlSnippet): boolean {
  return snippet.id.startsWith("builtin-");
}

function applyBuiltinSnippetKeywordCase(snippet: SqlSnippet, text: string, keywordCase?: SqlKeywordCase): string {
  if (!shouldFormatBuiltinSnippet(snippet)) return text;
  if (keywordCase === "lower") return text.toLowerCase();
  return text;
}

const BUILTIN_SNIPPET_PLACEHOLDER_RE = /\b(idx_name|left_column|right_column|columns|values|condition|column|default|value|name|type|table)\b/g;

function applyBuiltinSnippetPlaceholders(snippet: SqlSnippet): string {
  if (!shouldFormatBuiltinSnippet(snippet)) return snippet.body;
  return snippet.body.replace(BUILTIN_SNIPPET_PLACEHOLDER_RE, (match) => `\${${match}}`);
}

function buildPreferredKeywordItems(prefix: string, keywords: string[], keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  return keywords
    .filter((keyword) => matchesPrefix(keyword, prefix))
    .map((keyword, index) => ({
      label: applySqlKeywordCase(keyword, keywordCase),
      type: "keyword" as const,
      boost: computeBoost(keyword, prefix) + 6200 - index,
    }));
}

function buildStarExpansionItem(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem | null {
  const columns = context.qualifier ? referencedTablesForSelectAllColumns(context).flatMap((ref) => columnsForSelectAllReferencedTable(ref, columnsByTable)) : [...columnsByTable.values()].flat();
  const uniqueColumns = uniqueColumnsByName(columns);
  if (uniqueColumns.length === 0) return null;
  // `alias.*` replaces only the `*`, so the first column must continue the already typed `alias.`.
  const expansion = context.qualifier ? buildSelectAllColumnExpansion(uniqueColumns, context.qualifier, true, dialect) : uniqueColumns.map((column) => quoteSqlIdentifier(column.name, dialect)).join(", ");
  return {
    label: "* → columns",
    type: "snippet" as const,
    detail: `${(t?.starExpansionColumns ?? "{count} columns").replace("{count}", String(uniqueColumns.length))}: ${expansion.length > 60 ? expansion.slice(0, 57) + "..." : expansion}`,
    apply: expansion,
    boost: 1900,
  };
}

function buildSelectAllColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  if (!context.selectListColumnContext || context.statementKind !== "select" || context.onStar || context.referencedTables.length === 0) {
    return [];
  }

  const items: SqlCompletionItem[] = [];
  const emittedRefs = new Set<string>();
  const targetRefs = referencedTablesForSelectAllColumns(context);
  const shouldQualify = !!context.qualifier || context.referencedTables.length > 1;

  for (const ref of targetRefs) {
    const displayRef = context.qualifier || ref.alias || ref.name;
    const refKey = `${displayRef}.${ref.schema ?? ""}.${ref.name}`.toLowerCase();
    if (emittedRefs.has(refKey)) continue;
    emittedRefs.add(refKey);

    const columns = uniqueColumnsByName(columnsForSelectAllReferencedTable(ref, columnsByTable));
    if (columns.length === 0) continue;

    const label = `${displayRef}.*`;
    if (!selectAllColumnItemMatchesPrefix(label, ref, columns, context.prefix)) continue;

    const qualifier = context.qualifier || ref.alias || (shouldQualify ? quoteSqlIdentifier(ref.name, dialect) : undefined);
    const expansion = buildSelectAllColumnExpansion(columns, qualifier, !!context.qualifier, dialect);
    const countText = (t?.starExpansionColumns ?? "{count} columns").replace("{count}", String(columns.length));
    items.push({
      label,
      type: "snippet" as const,
      detail: `${countText}: ${expansion.length > 60 ? expansion.slice(0, 57) + "..." : expansion}`,
      apply: expansion,
      boost: 2400 + selectAllColumnItemPrefixBoost(label, ref, columns, context.prefix) - items.length,
    });
  }

  return items;
}

function buildInsertAllColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  if (!context.insertTable) return [];
  const columns = uniqueColumnsByName(columnsForInsertTarget(context, columnsByTable));
  if (columns.length === 0) return [];

  const label = `${context.insertTable}.*`;
  if (!selectAllColumnItemMatchesPrefix(label, { name: context.insertTable, schema: context.insertSchema }, columns, context.prefix)) return [];

  const expansion = columns.map((column) => quoteSqlIdentifier(column.name, dialect)).join(", ");
  const countText = (t?.starExpansionColumns ?? "{count} columns").replace("{count}", String(columns.length));
  return [
    {
      label,
      type: "snippet" as const,
      detail: `${countText}: ${expansion.length > 60 ? expansion.slice(0, 57) + "..." : expansion}`,
      apply: expansion,
      boost: 2450 + selectAllColumnItemPrefixBoost(label, { name: context.insertTable, schema: context.insertSchema }, columns, context.prefix),
    },
  ];
}

function referencedTablesForSelectAllColumns(context: SqlCompletionContext): SqlCompletionReferencedTable[] {
  if (!context.qualifier) return context.referencedTables;
  const qualifier = context.qualifier;
  const qualifierLower = qualifier.toLowerCase();
  const qualifiedTarget = qualifiedTableTargetFromContext(context);
  return context.referencedTables.filter((table) => referencedTableMatchesColumnQualifier(table, qualifier, qualifierLower, qualifiedTarget));
}

function buildSelectAllColumnExpansion(columns: SqlCompletionColumn[], qualifier: string | undefined, qualifierAlreadyTyped: boolean, dialect?: "mysql" | "postgres" | "sqlserver"): string {
  return columns
    .map((column, index) => {
      const columnName = quoteSqlIdentifier(column.name, dialect);
      if (!qualifier || (qualifierAlreadyTyped && index === 0)) return columnName;
      return `${qualifier}.${columnName}`;
    })
    .join(", ");
}

function columnsForSelectAllReferencedTable(table: SqlCompletionReferencedTable, columnsByTable: Map<string, SqlCompletionColumn[]>): SqlCompletionColumn[] {
  const columns = columnsForReferencedTable(table, columnsByTable);
  if (columns.length > 0) return columns;
  if (!table.columns || table.columns.length === 0) return [];
  return table.columns.map((name) => ({ name, table: table.name, schema: table.schema }));
}

function uniqueColumnsByName(columns: SqlCompletionColumn[]): SqlCompletionColumn[] {
  const seen = new Set<string>();
  const unique: SqlCompletionColumn[] = [];
  for (const column of columns) {
    const key = normalizeIdentifierPart(column.name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(column);
  }
  return unique;
}

function selectAllColumnItemMatchesPrefix(label: string, ref: SqlCompletionReferencedTable, columns: SqlCompletionColumn[], prefix: string): boolean {
  if (!prefix) return true;
  if (matchesPrefix(label, prefix) || matchesPrefix(ref.name, prefix) || (!!ref.alias && matchesPrefix(ref.alias, prefix))) return true;
  return columns.some((column) => matchesPrefix(column.name, prefix));
}

function selectAllColumnItemPrefixBoost(label: string, ref: SqlCompletionReferencedTable, columns: SqlCompletionColumn[], prefix: string): number {
  if (!prefix) return 0;
  const scores = [computeBoost(label, prefix), computeBoost(ref.name, prefix), ref.alias ? computeBoost(ref.alias, prefix) : -1, ...columns.map((column) => computeBoost(column.name, prefix))];
  return Math.min(Math.max(...scores, 0), 1000);
}

function buildComparisonValueItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const colName = context.comparisonLeftColumn!;
  const parts = colName.split(".");
  const unqualified = parts.length > 1 ? parts[parts.length - 1]! : colName;
  const qualifier = parts.length > 1 ? parts[0] : undefined;

  // Resolve alias to actual table name
  let resolvedTable: string | undefined;
  if (qualifier) {
    const ref = context.referencedTables.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase());
    resolvedTable = ref?.name?.toLowerCase();
  }

  // Find the column's data type
  let dataType: string | undefined;
  for (const [, cols] of columnsByTable) {
    for (const col of cols) {
      if (col.name.toLowerCase() === unqualified.toLowerCase()) {
        if (qualifier) {
          const qualLower = qualifier.toLowerCase();
          if (col.table.toLowerCase() === qualLower || col.schema?.toLowerCase() === qualLower || col.table.toLowerCase() === resolvedTable) {
            dataType = col.dataType;
            break;
          }
        } else {
          dataType = col.dataType;
          break;
        }
      }
    }
    if (dataType) break;
  }

  const items: SqlCompletionItem[] = [];

  // NULL check — always useful
  items.push({
    label: applySqlKeywordCase("NULL", keywordCase),
    type: "keyword" as const,
    detail: t?.nullValue ?? "NULL value",
    boost: 1300,
  });
  items.push({
    label: applySqlKeywordCase("IS NULL", keywordCase),
    type: "keyword" as const,
    detail: t?.isNull ?? "Checks whether the value is NULL",
    boost: 1250,
  });
  items.push({
    label: applySqlKeywordCase("IS NOT NULL", keywordCase),
    type: "keyword" as const,
    detail: t?.isNotNull ?? "Checks whether the value is not NULL",
    boost: 1200,
  });

  if (!dataType) return items;

  const prefix = context.prefix;
  const dt = dataType.toLowerCase();

  // String-like types: suggest quoted string snippet
  if (dt.includes("char") || dt.includes("text") || dt === "varchar" || dt === "nvarchar" || dt === "ntext") {
    if (matchesPrefix("''", prefix) || !prefix) {
      items.push({
        label: "''",
        type: "snippet" as const,
        detail: t?.stringLiteral ?? "String literal",
        apply: "'${value}'",
        boost: 1800,
      });
    }
  }

  // Numeric types: suggest number placeholder
  if (dt.includes("int") || dt.includes("decimal") || dt.includes("numeric") || dt.includes("float") || dt.includes("real") || dt.includes("money") || dt === "bigint" || dt === "smallint" || dt === "tinyint") {
    if (matchesPrefix("0", prefix) || !prefix) {
      items.push({
        label: "0",
        type: "snippet" as const,
        detail: t?.numericLiteral ?? "Numeric literal",
        apply: "${1:value}",
        boost: 1750,
      });
    }
  }

  // Boolean-ish: tinyint or bit
  if (dt === "bit" || dt === "boolean" || dt === "bool") {
    items.push({ label: "TRUE", type: "keyword" as const, detail: t?.booleanValue ?? "Boolean value", boost: 1700 }, { label: "FALSE", type: "keyword" as const, detail: t?.booleanValue ?? "Boolean value", boost: 1650 });
  }

  return items;
}

function buildAliasItems(context: SqlCompletionContext, databaseType?: DatabaseType): SqlCompletionItem[] {
  const items: SqlCompletionItem[] = [];
  const existingAliases = new Set(context.referencedTables.map((ref) => ref.alias?.toLowerCase()).filter((alias): alias is string => !!alias));
  const seen = new Set<string>(existingAliases);
  for (const ref of context.referencedTables) {
    if (ref.alias) continue;
    if (context.prefix && !matchesPrefix(ref.name, context.prefix)) continue;
    const candidate = generateAlias(ref.name, seen);
    if (!candidate || seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    items.push({
      label: candidate,
      type: "snippet" as const,
      detail: `alias for ${ref.name}`,
      apply: formatAliasCompletionApply(candidate, databaseType),
      boost: 1600 - items.length,
    });
  }
  return items;
}

function formatTableAliasApply(tableName: string, alias: string, databaseType?: DatabaseType): string {
  if (!alias) return tableName;
  return isOracleLikeDatabase(databaseType) ? `${tableName} ${alias}` : `${tableName} AS ${alias}`;
}

function formatAliasCompletionApply(alias: string, databaseType?: DatabaseType): string {
  return isOracleLikeDatabase(databaseType) ? `${alias} ` : `AS ${alias} `;
}

function generateAlias(tableName: string, existing = new Set<string>()): string {
  const candidates = buildAliasCandidates(tableName);

  for (const candidate of candidates.filter(Boolean)) {
    if (!aliasConflicts(candidate, existing)) return candidate;
  }

  const fallback = candidates.find(Boolean) ?? "tb";
  for (let index = 2; index < 100; index++) {
    const candidate = `${fallback}${index}`;
    if (!aliasConflicts(candidate, existing)) return candidate;
  }
  return fallback;
}

function generateTableCompletionAlias(tableName: string, existing = new Set<string>()): string {
  const candidates = buildAliasCandidates(tableName);

  for (const candidate of candidates.filter(Boolean)) {
    if (isUnsafeSqlAlias(candidate.toLowerCase())) continue;
    if (!existing.has(candidate.toLowerCase())) return candidate;
    for (let index = 2; index < 100; index++) {
      const numbered = `${candidate}${index}`;
      if (!aliasConflicts(numbered, existing)) return numbered;
    }
  }

  return generateAlias(tableName, existing);
}

function buildAliasCandidates(tableName: string): string[] {
  const parts = identifierWords(tableName);
  const candidates: string[] = [];

  if (parts.length > 1) {
    const initials = parts.map((part) => part[0]).join("");
    if (initials.length >= 2) candidates.push(initials);
    candidates.push(parts[0].slice(0, 2), parts[0].slice(0, 3));
  } else {
    const name = parts[0] ?? tableName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const chars = [...name];
    const consonants = chars.slice(1).filter((ch) => /[a-z]/.test(ch) && !"aeiou".includes(ch));
    if (chars.length <= 3) candidates.push(name);
    if (chars.length >= 2 && consonants[0]) candidates.push(`${chars[0]}${consonants[0]}`);
    if (chars.length >= 2) candidates.push(chars.slice(0, 2).join(""));
    if (chars.length >= 3 && consonants.length >= 2) candidates.push(`${chars[0]}${consonants[0]}${consonants[1]}`);
    if (chars.length >= 3) candidates.push(chars.slice(0, 3).join(""));
  }

  return candidates;
}

function aliasConflicts(candidate: string, existing: Set<string>): boolean {
  const lower = candidate.toLowerCase();
  return existing.has(lower) || isUnsafeSqlAlias(lower);
}

function isUnsafeSqlAlias(candidate: string): boolean {
  return SQL_ALIAS_RESERVED_WORDS.has(candidate) || SQL_ALIAS_KEYWORD_WORDS.has(candidate);
}

function isFollowedByJoin(beforeToken: string): boolean {
  const words = beforeToken.trimEnd().split(/\s+/);
  const second = words[words.length - 2]?.toLowerCase();
  return second === "join" || JOIN_MODIFIERS.has(second ?? "");
}

function isInTableListContext(beforeToken: string): boolean {
  if (isInOrderOrGroupByContext(beforeToken)) return false;
  const cleaned = stripSqlLiterals(beforeToken).trimEnd();
  if (!/,\s*$/.test(cleaned)) return false;

  // Only commas in the active top-level table segment should continue table completion.
  const lastTableIntro = Math.max(lastTopLevelKeywordIndex(cleaned, "from"), lastTopLevelKeywordIndex(cleaned, "join"), lastTopLevelKeywordIndex(cleaned, "update"), lastTopLevelKeywordIndex(cleaned, "into"));
  if (lastTableIntro < 0) return false;

  const lastBoundary = Math.max(
    lastTopLevelKeywordIndex(cleaned, "where"),
    lastTopLevelKeywordIndex(cleaned, "set"),
    lastTopLevelKeywordIndex(cleaned, "group"),
    lastTopLevelKeywordIndex(cleaned, "order"),
    lastTopLevelKeywordIndex(cleaned, "having"),
    lastTopLevelKeywordIndex(cleaned, "limit"),
    lastTopLevelKeywordIndex(cleaned, "offset"),
    lastTopLevelKeywordIndex(cleaned, "union"),
    lastTopLevelKeywordIndex(cleaned, "intersect"),
    lastTopLevelKeywordIndex(cleaned, "except"),
  );
  return lastBoundary < lastTableIntro;
}

function collectCompletionColumns(columnsByTable: Map<string, SqlCompletionColumn[]>): Array<SqlCompletionColumn & { key: string }> {
  const allColumns: Array<SqlCompletionColumn & { key: string }> = [];
  for (const [key, cols] of columnsByTable.entries()) {
    for (const col of cols) {
      allColumns.push({ ...col, key });
    }
  }
  return allColumns;
}

function columnsForInsertTarget(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>): Array<SqlCompletionColumn & { key: string }> {
  if (!context.insertTable) return [];
  const tableKey = normalizeIdentifierPart(context.insertTable);
  const schemaKey = context.insertSchema ? normalizeIdentifierPart(context.insertSchema) : undefined;
  const qualifiedKey = schemaKey ? normalizeCompletionKey(`${context.insertSchema}.${context.insertTable}`) : undefined;
  return collectCompletionColumns(columnsByTable).filter((column) => {
    if (normalizeIdentifierPart(column.table) !== tableKey) return false;
    if (!schemaKey) return true;
    if (column.schema && normalizeIdentifierPart(column.schema) === schemaKey) return true;
    return !!qualifiedKey && normalizeCompletionKey(column.key) === qualifiedKey;
  });
}

function buildColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  // Collect all columns from the map (all tables have been fetched)
  const allColumns = collectCompletionColumns(columnsByTable);

  // Handle INSERT column list: filter to only the target table
  let relevantCols = allColumns;
  if (context.insertTable) {
    relevantCols = columnsForInsertTarget(context, columnsByTable);
  } else if (context.qualifier) {
    const q = context.qualifier;
    const qLower = q.toLowerCase();
    const qualifiedTarget = qualifiedTableTargetFromContext(context);
    const relatedTables = context.referencedTables.filter((table) => referencedTableMatchesColumnQualifier(table, q, qLower, qualifiedTarget));
    relevantCols = relatedTables.flatMap((table) => completionColumnsForReferencedTable(table, allColumns));
    if (relatedTables.length === 0 && qualifiedTarget) relevantCols = allColumns.filter((column) => columnMatchesQualifiedTable(column, qualifiedTarget));
  } else if (context.referencedTables.length > 0) {
    relevantCols = context.referencedTables.flatMap((table) => completionColumnsForReferencedTable(table, allColumns));
  }

  // Count name frequencies to detect duplicates across tables
  const nameCount = new Map<string, number>();
  for (const c of relevantCols) {
    nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  }

  // Deduplicate — for dupes, qualify with table name
  const seen = new Set<string>();
  const uniqueColumns: Array<SqlCompletionColumn & { key: string; displayLabel: string }> = [];
  for (const c of relevantCols) {
    const count = nameCount.get(c.name) || 0;
    if (count > 1) {
      const qualifier = c.sourceAlias ?? c.table;
      const qualifiedKey = `${qualifier}.${c.name}`;
      if (seen.has(qualifiedKey)) continue;
      seen.add(qualifiedKey);
      uniqueColumns.push({ ...c, key: c.key, displayLabel: `${qualifier}.${c.name}` });
    } else {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      uniqueColumns.push({ ...c, key: c.key, displayLabel: c.name });
    }
  }

  // When the query already references concrete tables (or we are after a
  // "table." qualifier / in an INSERT column list), the columns of those
  // tables are what the user is most likely picking — boost them above plain
  // keywords so they rank at the top instead of being interleaved.
  const relevanceBoost = context.referencedTables.length > 0 || !!context.qualifier || !!context.insertTable ? 2000 : 0;

  return uniqueColumns
    .filter((column) => matchesPrefix(column.displayLabel, context.prefix))
    .map((column) => {
      const keyBoost = isKeyColumn(column.name) ? 500 : 0;
      return {
        label: column.displayLabel,
        type: "column" as const,
        detail: buildColumnDetail(column),
        info: buildColumnInfo(column),
        apply: buildColumnApply(column, context, dialect),
        boost: computeBoost(column.displayLabel, context.prefix) + keyBoost + relevanceBoost,
      };
    })
    .sort(compareCompletionItems);
}

function completionColumnsForReferencedTable<T extends SqlCompletionColumn & { key: string }>(table: SqlCompletionReferencedTable, columns: readonly T[]): T[] {
  const matched = columns.filter((column) => columnMatchesReferencedTable(column, table));
  const aliasedColumns = applyReferencedColumnAliases(table, matched);
  if (!table.alias) return aliasedColumns;
  return aliasedColumns.map((column) => ({ ...column, sourceAlias: table.alias }));
}

function applyReferencedColumnAliases<T extends SqlCompletionColumn>(table: SqlCompletionReferencedTable, columns: readonly T[]): T[] {
  if (!table.columnAliases?.length) return [...columns];
  return columns.map((column, index) => {
    const alias = table.columnAliases?.[index];
    return alias ? { ...column, name: alias } : column;
  });
}

function hasMatchingReferencedColumnPrefix(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>): boolean {
  if (!context.suggestColumns || !context.prefix || context.referencedTables.length === 0) return false;
  return context.referencedTables.some((table) => columnsForReferencedTable(table, columnsByTable).some((column) => matchesPrefix(column.name, context.prefix)));
}

function qualifiedTableTargetFromContext(context: SqlCompletionContext): { schema: string; table: string } | null {
  const parts = context.qualifierParts ?? context.qualifier?.split(".").filter(Boolean) ?? [];
  if (parts.length < 2) return null;
  const table = parts[parts.length - 1];
  const schema = parts[parts.length - 2];
  if (!schema || !table) return null;
  return { schema, table };
}

function referencedTableMatchesColumnQualifier(table: SqlCompletionReferencedTable, qualifier: string, qualifierLower: string, qualifiedTarget: { schema: string; table: string } | null): boolean {
  if (table.alias === qualifier || table.alias?.toLowerCase() === qualifierLower) return true;
  if (table.name === qualifier || table.name.toLowerCase() === qualifierLower) return true;
  if (!qualifiedTarget) return false;
  if (normalizeIdentifierPart(table.name) !== normalizeIdentifierPart(qualifiedTarget.table)) return false;
  return !table.schema || normalizeIdentifierPart(table.schema) === normalizeIdentifierPart(qualifiedTarget.schema);
}

function columnMatchesReferencedTable(column: SqlCompletionColumn & { key: string }, table: SqlCompletionReferencedTable): boolean {
  if (normalizeIdentifierPart(column.table) !== normalizeIdentifierPart(table.name)) return false;
  if (!table.schema) return true;
  return columnMatchesQualifiedTable(column, { schema: table.schema, table: table.name });
}

function columnMatchesQualifiedTable(column: SqlCompletionColumn & { key: string }, target: { schema: string; table: string }): boolean {
  if (normalizeIdentifierPart(column.table) !== normalizeIdentifierPart(target.table)) return false;
  if (column.schema && normalizeIdentifierPart(column.schema) === normalizeIdentifierPart(target.schema)) return true;
  return normalizeCompletionKey(column.key) === normalizeCompletionKey(`${target.schema}.${target.table}`);
}

function normalizeCompletionKey(key: string): string {
  return key
    .split(".")
    .filter(Boolean)
    .map((part) => normalizeIdentifierPart(part))
    .join(".");
}

function buildColumnApply(column: SqlCompletionColumn & { displayLabel: string }, context: SqlCompletionContext, dialect?: "mysql" | "postgres" | "sqlserver"): string {
  if (context.qualifier || column.displayLabel === column.name || !column.displayLabel.includes(".")) {
    return quoteSqlIdentifier(column.name, dialect);
  }
  return `${quoteSqlIdentifier(column.sourceAlias ?? column.table, dialect)}.${quoteSqlIdentifier(column.name, dialect)}`;
}

function isKeyColumn(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "id" || lower.endsWith("_id");
}

function buildColumnDetail(column: SqlCompletionColumn): string {
  const tableInfo = column.schema ? `${column.schema}.${column.table}` : column.table;
  let detail = column.dataType ? `${tableInfo}  [${column.dataType}]` : tableInfo;
  if (column.isNullable === false) {
    detail += "  NOT NULL";
  }
  const comment = column.comment?.trim();
  if (comment) {
    detail += `  -- ${comment}`;
  }
  return detail;
}

function buildColumnInfo(column: SqlCompletionColumn): string | undefined {
  const parts = [
    column.schema ? `${column.schema}.${column.table}.${column.name}` : `${column.table}.${column.name}`,
    column.dataType ? `Type: ${column.dataType}` : undefined,
    column.isNullable === false ? "Nullable: no" : column.isNullable === true ? "Nullable: yes" : undefined,
    column.comment?.trim() ? `Comment: ${column.comment.trim()}` : undefined,
  ].filter((part): part is string => !!part);
  return parts.length > 1 ? parts.join("\n") : undefined;
}

function buildJoinConditionItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>, dialect?: "mysql" | "postgres" | "sqlserver", keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const refs = context.referencedTables;
  if (refs.length < 2) return [];

  const latest = refs[refs.length - 1];
  const previousRefs = refs.slice(0, -1);
  const items: SqlCompletionItem[] = [];

  for (const previous of previousRefs) {
    const previousColumns = columnsForReferencedTable(previous, columnsByTable);
    const latestColumns = columnsForReferencedTable(latest, columnsByTable);
    items.push(...buildForeignKeyJoinConditionItemsForPair(previous, latest, foreignKeysByTable, context.prefix, dialect, keywordCase), ...buildJoinConditionItemsForPair(previous, previousColumns, latest, latestColumns, context.prefix, dialect, keywordCase));
  }

  return items;
}

function columnsForReferencedTable(table: SqlCompletionReferencedTable, columnsByTable: Map<string, SqlCompletionColumn[]>): SqlCompletionColumn[] {
  const keys = table.schema ? [`${table.schema}.${table.name}`, table.name] : [table.name];
  for (const key of keys) {
    const columns = columnsByTable.get(key);
    if (columns) return applyReferencedColumnAliases(table, columns);
  }
  return [];
}

function foreignKeysForReferencedTable(table: SqlCompletionReferencedTable, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>): SqlCompletionForeignKey[] {
  if (!foreignKeysByTable) return [];
  const keys = table.schema ? [`${table.schema}.${table.name}`, table.name] : [table.name];
  for (const key of keys) {
    const foreignKeys = foreignKeysByTable.get(key);
    if (foreignKeys) return foreignKeys;
  }
  return [];
}

function buildForeignKeyJoinConditionItemsForPair(left: SqlCompletionReferencedTable, right: SqlCompletionReferencedTable, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>, prefix = "", dialect?: "mysql" | "postgres" | "sqlserver", keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (!foreignKeysByTable) return [];
  return [
    ...buildDirectionalForeignKeyJoinConditionItems(left, right, foreignKeysForReferencedTable(left, foreignKeysByTable), prefix, dialect, keywordCase),
    ...buildDirectionalForeignKeyJoinConditionItems(right, left, foreignKeysForReferencedTable(right, foreignKeysByTable), prefix, dialect, keywordCase),
  ];
}

function buildDirectionalForeignKeyJoinConditionItems(owner: SqlCompletionReferencedTable, referenced: SqlCompletionReferencedTable, foreignKeys: SqlCompletionForeignKey[], prefix: string, dialect?: "mysql" | "postgres" | "sqlserver", keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const matchingForeignKeys = foreignKeys.filter((foreignKey) => referencedTableMatchesName(referenced, foreignKey.ref_table, foreignKey.ref_schema));
  const groups = groupForeignKeysByConstraint(matchingForeignKeys);
  const items: SqlCompletionItem[] = [];

  for (const group of groups) {
    const parts = group.map((foreignKey) => buildJoinConditionPart(owner, foreignKey.column, referenced, foreignKey.ref_column, dialect));
    const joiner = keywordJoiner(keywordCase);
    const label = parts.map((part) => part.label).join(joiner);
    if (!label || (prefix && !matchesPrefix(label, prefix))) continue;
    const apply = parts.map((part) => part.apply).join(joiner);
    items.push({
      label,
      type: "snippet",
      detail: group.length > 1 ? "JOIN condition from composite foreign key" : "JOIN condition from foreign key",
      apply,
      boost: 3200 + group.length,
    });
  }

  return items;
}

function buildJoinConditionPart(owner: SqlCompletionReferencedTable, ownerColumn: string, referenced: SqlCompletionReferencedTable, referencedColumn: string, dialect?: "mysql" | "postgres" | "sqlserver"): { label: string; apply: string } {
  const ownerRef = owner.alias || owner.name;
  const referencedRef = referenced.alias || referenced.name;
  const ownerApplyRef = owner.alias ? owner.alias : quoteSqlIdentifier(owner.name, dialect);
  const referencedApplyRef = referenced.alias ? referenced.alias : quoteSqlIdentifier(referenced.name, dialect);
  return {
    label: `${ownerRef}.${ownerColumn} = ${referencedRef}.${referencedColumn}`,
    apply: `${ownerApplyRef}.${quoteSqlIdentifier(ownerColumn, dialect)} = ${referencedApplyRef}.${quoteSqlIdentifier(referencedColumn, dialect)}`,
  };
}

function groupForeignKeysByConstraint(foreignKeys: SqlCompletionForeignKey[]): SqlCompletionForeignKey[][] {
  const groups = new Map<string, SqlCompletionForeignKey[]>();
  for (const foreignKey of foreignKeys) {
    const key = `${foreignKey.name || `${foreignKey.column}->${foreignKey.ref_table}.${foreignKey.ref_column}`}:${foreignKey.ref_table}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(foreignKey);
  }
  return [...groups.values()];
}

function referencedTableMatchesName(table: SqlCompletionReferencedTable, candidate: string, candidateSchema?: string | null): boolean {
  const normalizedCandidate = normalizeTableName(candidate);
  if (normalizeTableName(table.name) !== normalizedCandidate) return false;
  if (!candidateSchema || !table.schema) return true;
  return normalizeIdentifierPart(table.schema) === normalizeIdentifierPart(candidateSchema);
}

function normalizeTableName(name: string): string {
  return name
    .split(".")
    .filter(Boolean)
    .pop()!
    .replace(/^["`[]|["`\]]$/g, "")
    .toLowerCase();
}

function normalizeIdentifierPart(name: string): string {
  return name.replace(/^["`[]|["`\]]$/g, "").toLowerCase();
}

function buildJoinConditionItemsForPair(left: SqlCompletionReferencedTable, leftColumns: SqlCompletionColumn[], right: SqlCompletionReferencedTable, rightColumns: SqlCompletionColumn[], prefix: string, dialect?: "mysql" | "postgres" | "sqlserver", keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const items: SqlCompletionItem[] = [];
  const leftRef = left.alias || left.name;
  const rightRef = right.alias || right.name;
  const leftApplyRef = left.alias ? left.alias : quoteSqlIdentifier(left.name, dialect);
  const rightApplyRef = right.alias ? right.alias : quoteSqlIdentifier(right.name, dialect);
  const leftTableKey = singularTableName(left.name);
  const rightTableKey = singularTableName(right.name);

  const leftByName = indexColumnsByLowerName(leftColumns);
  const rightByName = indexColumnsByLowerName(rightColumns);
  const emittedPairs = new Set<string>();

  const addPair = (leftColumn: SqlCompletionColumn | undefined, rightColumn: SqlCompletionColumn | undefined, boost: number) => {
    if (!leftColumn || !rightColumn || !areJoinColumnTypesCompatible(leftColumn, rightColumn)) return;
    const key = `${leftColumn.name.toLowerCase()}:${rightColumn.name.toLowerCase()}`;
    if (emittedPairs.has(key)) return;
    emittedPairs.add(key);
    const label = `${leftRef}.${leftColumn.name} = ${rightRef}.${rightColumn.name}`;
    if (prefix && !matchesPrefix(label, prefix)) return;
    const apply = `${leftApplyRef}.${quoteSqlIdentifier(leftColumn.name, dialect)} = ${rightApplyRef}.${quoteSqlIdentifier(rightColumn.name, dialect)}`;
    items.push({
      label,
      type: "snippet",
      detail: "JOIN condition",
      apply,
      boost,
    });
  };

  const leftId = leftByName.get("id")?.[0];
  const rightId = rightByName.get("id")?.[0];

  // Pattern 1: a.id = b.{singular_a}_id  (e.g., users.id = orders.user_id)
  addPair(leftId, rightByName.get(`${leftTableKey}_id`)?.[0], 2300);
  // Pattern 2: a.{singular_b}_id = b.id  (e.g., orders.user_id = users.id)
  addPair(leftByName.get(`${rightTableKey}_id`)?.[0], rightId, 2300);

  // Pattern 3/4: same-name columns, with FK-looking names above generic shared columns.
  for (const [name, leftMatches] of leftByName.entries()) {
    if (name === "id") continue;
    const rightMatches = rightByName.get(name);
    if (!rightMatches?.length) continue;
    addPair(leftMatches[0], rightMatches[0], name.endsWith("_id") ? 2000 : 1700);
  }

  // Pattern 5: parent_id -> id (self-referencing / hierarchical)
  if (leftTableKey === rightTableKey) {
    addPair(leftByName.get("parent_id")?.[0], rightId, 2100);
    addPair(leftId, rightByName.get("parent_id")?.[0], 2100);
  }

  // Pattern 6: created_by / modified_by / owned_by -> users.id
  for (const auditColumnName of ["created_by", "modified_by", "owned_by"]) {
    addPair(leftId, rightByName.get(auditColumnName)?.[0], 1800);
    addPair(leftByName.get(auditColumnName)?.[0], rightId, 1800);
  }

  // Pattern 7: Generic FK column -> id when table names do not reveal the relationship.
  for (const leftColumn of leftColumns) {
    const leftName = leftColumn.name.toLowerCase();
    if (leftName !== "id" && leftName.endsWith("_id")) addPair(leftColumn, rightId, 1650);
  }
  for (const rightColumn of rightColumns) {
    const rightName = rightColumn.name.toLowerCase();
    if (rightName !== "id" && rightName.endsWith("_id")) addPair(leftId, rightColumn, 1650);
  }

  items.push(...buildCompositeHeuristicJoinConditionItems(left, leftColumns, right, leftByName, rightByName, prefix, dialect, keywordCase));

  return items;
}

function indexColumnsByLowerName(columns: SqlCompletionColumn[]): Map<string, SqlCompletionColumn[]> {
  const index = new Map<string, SqlCompletionColumn[]>();
  for (const column of columns) {
    const key = column.name.toLowerCase();
    const existing = index.get(key);
    if (existing) existing.push(column);
    else index.set(key, [column]);
  }
  return index;
}

function buildCompositeHeuristicJoinConditionItems(
  left: SqlCompletionReferencedTable,
  leftColumns: SqlCompletionColumn[],
  right: SqlCompletionReferencedTable,
  leftByName: Map<string, SqlCompletionColumn[]>,
  rightByName: Map<string, SqlCompletionColumn[]>,
  prefix: string,
  dialect?: "mysql" | "postgres" | "sqlserver",
  keywordCase?: SqlKeywordCase,
): SqlCompletionItem[] {
  const leftId = leftByName.get("id")?.[0];
  const rightId = rightByName.get("id")?.[0];
  const leftTableKey = singularTableName(left.name);
  const rightTableKey = singularTableName(right.name);
  const candidates: Array<{ parent: "left" | "right"; parentId: SqlCompletionColumn; childFk: SqlCompletionColumn }> = [];
  const rightNamedFk = rightByName.get(`${leftTableKey}_id`)?.[0];
  const leftNamedFk = leftByName.get(`${rightTableKey}_id`)?.[0];
  if (leftId && rightNamedFk && areJoinColumnTypesCompatible(leftId, rightNamedFk)) {
    candidates.push({ parent: "left", parentId: leftId, childFk: rightNamedFk });
  }
  if (rightId && leftNamedFk && areJoinColumnTypesCompatible(leftNamedFk, rightId)) {
    candidates.push({ parent: "right", parentId: rightId, childFk: leftNamedFk });
  }
  if (candidates.length === 0) return [];

  const sharedScopeColumns = leftColumns
    .map((leftColumn) => {
      const name = leftColumn.name.toLowerCase();
      const rightColumn = rightByName.get(name)?.[0];
      if (!rightColumn || !isLikelyScopeColumnName(name) || !areJoinColumnTypesCompatible(leftColumn, rightColumn)) {
        return null;
      }
      return { leftColumn, rightColumn };
    })
    .filter((value): value is { leftColumn: SqlCompletionColumn; rightColumn: SqlCompletionColumn } => !!value)
    .slice(0, 2);
  if (sharedScopeColumns.length === 0) return [];

  const leftRef = left.alias || left.name;
  const rightRef = right.alias || right.name;
  const leftApplyRef = left.alias ? left.alias : quoteSqlIdentifier(left.name, dialect);
  const rightApplyRef = right.alias ? right.alias : quoteSqlIdentifier(right.name, dialect);
  const items: SqlCompletionItem[] = [];

  for (const candidate of candidates.slice(0, 2)) {
    const parts = sharedScopeColumns.map(({ leftColumn, rightColumn }) => buildHeuristicJoinConditionPart(leftRef, leftApplyRef, leftColumn, rightRef, rightApplyRef, rightColumn, dialect));
    if (candidate.parent === "left") {
      parts.push(buildHeuristicJoinConditionPart(leftRef, leftApplyRef, candidate.parentId, rightRef, rightApplyRef, candidate.childFk, dialect));
    } else {
      parts.push(buildHeuristicJoinConditionPart(leftRef, leftApplyRef, candidate.childFk, rightRef, rightApplyRef, candidate.parentId, dialect));
    }
    const joiner = keywordJoiner(keywordCase);
    const label = parts.map((part) => part.label).join(joiner);
    if (prefix && !matchesPrefix(label, prefix)) continue;
    items.push({
      label,
      type: "snippet",
      detail: "Likely composite JOIN condition",
      apply: parts.map((part) => part.apply).join(joiner),
      boost: 2400 + parts.length,
    });
  }

  return items;
}

function buildHeuristicJoinConditionPart(leftRef: string, leftApplyRef: string, leftColumn: SqlCompletionColumn, rightRef: string, rightApplyRef: string, rightColumn: SqlCompletionColumn, dialect?: "mysql" | "postgres" | "sqlserver"): { label: string; apply: string } {
  return {
    label: `${leftRef}.${leftColumn.name} = ${rightRef}.${rightColumn.name}`,
    apply: `${leftApplyRef}.${quoteSqlIdentifier(leftColumn.name, dialect)} = ${rightApplyRef}.${quoteSqlIdentifier(rightColumn.name, dialect)}`,
  };
}

function isLikelyScopeColumnName(name: string): boolean {
  return name !== "id" && (name.endsWith("_id") || name === "tenant" || name === "tenant_id" || name === "account_id" || name === "workspace_id" || name === "organization_id" || name === "org_id");
}

function areJoinColumnTypesCompatible(left: SqlCompletionColumn, right: SqlCompletionColumn): boolean {
  const leftType = normalizeJoinType(left.dataType);
  const rightType = normalizeJoinType(right.dataType);
  if (!leftType || !rightType) return true;
  return leftType === rightType;
}

function normalizeJoinType(dataType?: string): string | null {
  if (!dataType) return null;
  const type = dataType.toLowerCase();
  if (/\b(uuid|uniqueidentifier)\b/.test(type)) return "uuid";
  if (/\b(bigint|int8|integer|int|int4|smallint|int2|tinyint|serial|bigserial|number|numeric|decimal)\b/.test(type)) {
    return "number";
  }
  if (/\b(char|text|clob|string|varchar|nvarchar|nchar|uuid)\b/.test(type)) return "text";
  if (/\b(bool|boolean|bit)\b/.test(type)) return "boolean";
  if (/\b(date|time|timestamp|datetime)\b/.test(type)) return "temporal";
  return type.replace(/\(.+\)/, "").trim() || null;
}

function singularTableName(name: string): string {
  const lower = name.toLowerCase();
  // Irregular plurals
  if (lower.endsWith("ies") && lower.length > 3) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ives") && lower.length > 4) return `${lower.slice(0, -4)}f`; // lives → life
  if (lower.endsWith("ves") && lower.length > 3) {
    const stem = lower.slice(0, -3);
    if (stem.endsWith("el") || stem.endsWith("lf")) return `${stem}fe`; // shelves → shelf, halves → half
    return `${stem}f`; // calves → calf
  }
  if (lower.endsWith("ses") && lower.length > 3) {
    const stem = lower.slice(0, -2); // statuses → status, buses → bus
    if (stem.endsWith("s") || stem.endsWith("x") || stem.endsWith("z") || stem.endsWith("ch") || stem.endsWith("sh")) {
      return stem;
    }
  }
  if (lower.endsWith("xes") && lower.length > 3) return lower.slice(0, -2); // boxes → box
  if (lower.endsWith("ches") && lower.length > 4) return lower.slice(0, -2); // matches → match
  if (lower.endsWith("shes") && lower.length > 4) return lower.slice(0, -2); // dishes → dish
  if (lower.endsWith("ices") && lower.length > 4) {
    const stem = lower.slice(0, -4);
    if (stem === "ind") return "index";
    if (stem === "append") return "appendix";
    return `${stem}ex`; // matrices → matrix
  }
  if (lower.endsWith("men") && lower.length > 3) return `${lower}um`; // children → child... no, that's wrong
  if (lower === "children") return "child";
  if (lower === "people") return "person";
  if (lower === "data") return lower; // data is already singular-ish
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 1) return lower.slice(0, -1);
  return lower;
}

export function buildSnippetItemsForTest(prefix: string, snippets: SqlSnippet[], keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  return buildSnippetItems(prefix, snippets, keywordCase);
}

function buildSnippetItems(prefix: string, snippets: SqlSnippet[], keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (!prefix) return [];
  return snippets
    .filter((snippet) => {
      if (snippet.enabled === false) return false;
      const matchesSnippetPrefix = matchesPrefix(snippet.prefix, prefix);
      const matchesSnippetLabel = prefix.length > snippet.prefix.length && matchesPrefix(snippet.label, prefix);
      return matchesSnippetPrefix || matchesSnippetLabel;
    })
    .map((snippet) => {
      const boostByPrefix = computeBoost(snippet.prefix, prefix);
      const boostByLabel = computeBoost(snippet.label, prefix);
      const matchesByPrefix = matchesPrefix(snippet.prefix, prefix);
      // When the user types past the snippet prefix (e.g. "sele" vs prefix "sel"),
      // they are likely typing the actual keyword — reduce the base boost so
      // the real keyword can rank higher.
      const baseBoost = matchesByPrefix ? 4000 : 0;
      // Placeholder replacement runs on the original (UPPER-case) body first,
      // then keyword casing is applied to both variants uniformly.
      const body = applyBuiltinSnippetKeywordCase(snippet, snippet.body, keywordCase);
      const apply = applyBuiltinSnippetKeywordCase(snippet, applyBuiltinSnippetPlaceholders(snippet), keywordCase);
      return {
        label: snippet.label,
        type: "snippet" as const,
        detail: body,
        apply,
        boost: Math.max(boostByPrefix, boostByLabel) + baseBoost,
      };
    });
}

function activeFunctionSignatures(databaseType?: DatabaseType): Map<string, string[]> {
  const commonFunctionNames = databaseType === "cloudflare-d1" ? CLOUDFLARE_D1_COMMON_FUNCTION_NAMES : COMMON_SQL_FUNCTION_NAMES;
  const signatures = databaseType ? new Map(Array.from(SQL_FUNCTION_SIGNATURES.entries()).filter(([name]) => commonFunctionNames.has(name))) : new Map(SQL_FUNCTION_SIGNATURES);
  const databaseSignatures = databaseType ? DATABASE_FUNCTION_SIGNATURES[databaseType] : undefined;
  if (databaseSignatures) {
    for (const [name, parameters] of databaseSignatures) signatures.set(name, parameters);
  }
  return signatures;
}

function buildFunctionSnippetItems(prefix: string, functionDescriptions: Map<string, string>, databaseType?: DatabaseType): SqlCompletionItem[] {
  const items: SqlCompletionItem[] = [];

  for (const [name, parameters] of activeFunctionSignatures(databaseType).entries()) {
    if (!matchesPrefix(name, prefix)) continue;
    const paramStr = parameters.length > 0 ? parameters.map((p) => `\${${p}}`).join(", ") : "";
    items.push({
      label: name,
      type: "function" as const,
      detail: functionDescriptions.get(name) ?? "function",
      apply: `${name}(${paramStr})`,
      boost: computeBoost(name, prefix) + 300,
    });
  }

  // Window functions — complete with OVER() clause
  for (const name of WINDOW_FUNCTIONS) {
    if (!matchesPrefix(name, prefix)) continue;
    items.push({
      label: name,
      type: "function" as const,
      detail: "window function",
      apply: `${name}() OVER (PARTITION BY \${col} ORDER BY \${col})`,
      boost: computeBoost(name, prefix) + 250,
    });
  }

  return items;
}

function buildOracleSystemValueItems(prefix: string, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  return ORACLE_SYSTEM_VALUE_NAMES.filter((name) => matchesPrefix(name, prefix)).map((name) => {
    const label = applySqlKeywordCase(name, keywordCase);
    return {
      label,
      type: "function" as const,
      detail: "Oracle system value",
      apply: label,
      boost: computeBoost(name, prefix) + 300,
    };
  });
}

function mongoCompletionItemToSqlCompletionItem(item: MongoCompletionItem): SqlCompletionItem {
  return {
    label: item.label,
    type: item.type,
    detail: item.detail,
    info: item.info,
    apply: item.apply,
    boost: item.boost,
  };
}

function buildSelectAliasItems(context: SqlCompletionContext): SqlCompletionItem[] {
  return context.selectAliases
    .filter((alias) => matchesPrefix(alias, context.prefix))
    .map((alias, index) => ({
      label: alias,
      type: "column" as const,
      detail: "SELECT alias",
      boost: computeBoost(alias, context.prefix) + 3500 - index,
    }));
}

function buildNonAggregatedColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: "mysql" | "postgres" | "sqlserver"): SqlCompletionItem[] {
  const nonAggSet = new Set(context.nonAggregatedSelectColumns.map((c) => c.toLowerCase()));
  const seen = new Set<string>();

  const items: SqlCompletionItem[] = [];
  for (const [, cols] of columnsByTable) {
    for (const col of cols) {
      const key = col.name.toLowerCase();
      if (!nonAggSet.has(key) || seen.has(key)) continue;
      if (context.prefix && !matchesPrefix(col.name, context.prefix)) continue;
      seen.add(key);
      items.push({
        label: col.name,
        type: "column" as const,
        detail: "non-aggregated column — required in GROUP BY",
        apply: quoteSqlIdentifier(col.name, dialect),
        boost: 2800 - items.length,
      });
    }
  }

  return items;
}

function activeSqlKeywords(databaseType?: DatabaseType): string[] {
  if (databaseType === "mongodb") return [];
  const databaseKeywords = databaseType ? DATABASE_SQL_KEYWORDS[databaseType] : undefined;
  const keywords = databaseType ? Array.from(new Set([...COMMON_SQL_KEYWORDS, ...(databaseKeywords ?? [])])) : Array.from(new Set(SQL_KEYWORDS));
  return isOracleLikeDatabase(databaseType) ? keywords.filter((keyword) => !NON_ORACLE_COMPLETION_WORDS.has(keyword)) : keywords;
}

function isOracleLikeDatabase(databaseType?: DatabaseType): boolean {
  return databaseType === "oracle" || databaseType === "oceanbase-oracle";
}

function buildJoinModifierKeywordItems(prefix: string, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (!prefix) return [];
  return JOIN_MODIFIER_KEYWORD_PHRASES.filter((keyword) => matchesPrefix(keyword, prefix)).map((keyword) => {
    const label = applySqlKeywordCase(keyword, keywordCase);
    return {
      label,
      type: "keyword" as const,
      apply: `${label} `,
      detail: "join keyword",
      boost: computeBoost(keyword, prefix) + 1300,
    };
  });
}

function isPendingJoinKeywordContext(context: SqlCompletionContext): boolean {
  return !context.prefix && context.preferredKeywords.includes("JOIN") && !!context.tableTriggerWord && JOIN_MODIFIERS.has(context.tableTriggerWord);
}

function buildKeywordItems(prefix: string, context: SqlCompletionContext, databaseType?: DatabaseType, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const isDml = context.statementKind === "select" || context.statementKind === "insert" || context.statementKind === "update" || context.statementKind === "delete";
  const showDdl = !isDml || context.suggestTables;
  const functionSignatures = activeFunctionSignatures(databaseType);

  return activeSqlKeywords(databaseType)
    .filter((keyword) => {
      if (functionSignatures.has(keyword)) return false;
      if (WINDOW_FUNCTIONS.has(keyword)) return false;
      if (!matchesPrefix(keyword, prefix)) return false;
      if (!showDdl && isDml && (DDL_ONLY_KEYWORDS.has(keyword) || DATA_TYPE_KEYWORDS.has(keyword))) return false;
      return true;
    })
    .map((keyword) => {
      const base = computeBoost(keyword, prefix);
      const freqBoost = HIGH_FREQUENCY_KEYWORDS.has(keyword) ? 100 : 0;
      return {
        label: applySqlKeywordCase(keyword, keywordCase),
        type: "keyword" as const,
        boost: base + freqBoost,
      };
    });
}

function shouldOfferKeywordPrefixContinuations(context: SqlCompletionContext, pendingJoinKeyword: boolean): boolean {
  return !!context.prefix && !pendingJoinKeyword && !context.qualifier && !context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions;
}

function buildKeywordPrefixContinuationItems(prefix: string, context: SqlCompletionContext, databaseType?: DatabaseType, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const normalizedPrefix = prefix.toLowerCase();
  return buildKeywordItems(prefix, context, databaseType, keywordCase).filter((item) => {
    const normalizedLabel = item.label.toLowerCase();
    return normalizedLabel.length > normalizedPrefix.length && normalizedLabel.startsWith(normalizedPrefix);
  });
}

function matchesPrefix(candidate: string, prefix: string): boolean {
  if (!prefix) return true;
  return computeMatchScore(candidate, prefix) >= 0;
}

/**
 * Score how well `prefix` matches `candidate`.
 * Returns -1 for no match, or a positive score where higher = better match.
 *
 * Scoring tiers:
 *   Exact match:    3000 - len
 *   Initials match: 2400 + exactInitialsBonus - len
 *   Prefix match:   2000 - len
 *   Substring:      900 + boundaryBonus - len
 *   Tight fuzzy:    1500 - gapPenalty + earlyMatchBonus - len  (gaps < prefix length)
 *   Loose fuzzy:     500 + partialEarlyBonus - gapPenalty - len (gaps >= prefix length)
 */
function computeMatchScore(candidate: string, prefix: string): number {
  if (!prefix) return 1;
  const c = candidate.toLowerCase();
  const p = prefix.toLowerCase();

  // Exact match
  if (c === p) return 3000 - c.length;

  // Prefix match
  if (c.startsWith(p)) return 2000 - c.length;

  const initials = identifierInitials(candidate);
  if (initials && initials.startsWith(p)) {
    const exactInitialsBonus = initials === p ? 400 : 0;
    return 2400 + exactInitialsBonus - c.length;
  }

  const substringIndex = c.indexOf(p);
  if (substringIndex >= 0) {
    const boundaryBonus = isIdentifierBoundary(candidate, substringIndex) ? 400 : Math.max(0, 180 - substringIndex * 12);
    return 900 + boundaryBonus - c.length;
  }

  // Fuzzy match: chars must appear in order (allows gaps for typos/abbrevs)
  let ci = 0;
  let totalGap = 0;
  let firstMatchPos = -1;
  let boundaryBonus = 0;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    const nextPos = c.indexOf(ch, ci);
    if (nextPos === -1) {
      return -1;
    }
    if (firstMatchPos === -1) firstMatchPos = nextPos;
    if (isIdentifierBoundary(candidate, nextPos)) boundaryBonus += 40;
    totalGap += nextPos - ci;
    ci = nextPos + 1;
  }

  const earlyMatchBonus = Math.max(0, 700 - firstMatchPos * 35) + boundaryBonus;

  if (totalGap >= p.length) {
    // Too many gaps — low-confidence fuzzy match
    return 400 + earlyMatchBonus * 0.3 - totalGap * 20 - c.length;
  }

  const gapPenalty = totalGap * 10;
  return 1200 + earlyMatchBonus - gapPenalty - c.length;
}

function identifierWords(candidate: string): string[] {
  return candidate
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function identifierInitials(candidate: string): string {
  return identifierWords(candidate)
    .map((part) => part[0])
    .join("");
}

function isIdentifierBoundary(candidate: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = candidate[index - 1] ?? "";
  const current = candidate[index] ?? "";
  return /[^A-Za-z0-9]/.test(previous) || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(current));
}

function computeBoost(candidate: string, prefix: string): number {
  return computeMatchScore(candidate, prefix);
}

// --- History-based ranking ---
const completionStats = new Map<string, number>();

/** Record a user selection to boost future rankings. */
export function recordCompletionSelection(label: string, type: string): void {
  const key = `${type}:${label}`;
  completionStats.set(key, (completionStats.get(key) || 0) + 1);
}

function getHistoryBoost(label: string, type: string): number {
  const count = completionStats.get(`${type}:${label}`);
  if (!count) return 0;
  // Diminishing returns: first selection gives biggest boost
  return Math.min(count * 80, 500);
}

function dedupeAndSort(items: SqlCompletionItem[]): SqlCompletionItem[] {
  const seen = new Set<string>();
  return items.sort(compareCompletionItems).filter((item) => {
    const key = `${item.type}:${item.dedupeKey ?? item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareCompletionItems(left: SqlCompletionItem, right: SqlCompletionItem): number {
  if (!left.exactMatch !== !right.exactMatch) return left.exactMatch ? -1 : 1;
  const leftBonus = getHistoryBoost(left.label, left.type);
  const rightBonus = getHistoryBoost(right.label, right.type);
  return right.boost + rightBonus + getTypePriorityBoost(right.type) - (left.boost + leftBonus + getTypePriorityBoost(left.type));
}

function getTypePriorityBoost(type: SqlCompletionItem["type"]): number {
  switch (type) {
    case "column":
      return 180;
    case "table":
      return 160;
    case "schema":
      return 120;
    case "function":
      return 90;
    case "snippet":
      return 40;
    case "keyword":
      return 0;
  }
}

function findActiveFunctionOpenParen(sqlBeforeCursor: string): number | null {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = sqlBeforeCursor.length - 1; i >= 0; i--) {
    const ch = sqlBeforeCursor[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (ch === ")") {
      depth++;
    } else if (ch === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }

  return null;
}

function countTopLevelCommas(text: string): number {
  let count = 0;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) count++;
  }

  return count;
}
