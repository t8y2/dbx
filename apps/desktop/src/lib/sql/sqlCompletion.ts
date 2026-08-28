import { Cassandra, MariaSQL, MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import type { Completion, CompletionInfo } from "@codemirror/autocomplete";
import type { DatabaseType, SqlSnippet } from "@/types/database";
import { buildMongoCompletionItemsFromContext, type MongoCompletionItem } from "@/lib/mongo/mongoCompletion";
import { CLOUDFLARE_D1_COMMON_FUNCTION_NAMES } from "@/lib/sql/cloudflareD1";
import { searchClickHouseFunctions } from "@/lib/sql/clickhouse/functionRegistry";
import type { ClickHouseFunctionDefinition, ClickHouseFunctionKind } from "@/lib/sql/clickhouse/functionTypes";
import type { SqlObjectNavigationType } from "@/lib/sql/sqlNavigation";
import { resolveSqlDialectId } from "@/lib/sql/semantic/dialect";
import { findActiveSqlStatementSpan, matchDollarQuoteTag, tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";
import type { SqlSemanticBuildOptions, SqlSemanticSpan } from "@/lib/sql/semantic/types";
import { isEditorStatePlausibleFor, resolveLexicalLeafFromSyntaxTree, resolveSqlStatementWindow } from "@/lib/sql/sqlSyntaxTreeWindow";
import { DEFAULT_SQL_SNIPPETS, MANTICORESEARCH_SQL_SNIPPETS, resolveSqlSnippetBodyForDatabase } from "@/lib/sql/sqlSnippetTemplates";
import { requiresMysqlIdentifierQuote, requiresPostgresIdentifierQuote } from "@/lib/sql/sqlIdentifier";
import { identifierMatchScore, matchesIdentifierSearch } from "@/lib/sql/identifierSearch";
import { containsHan, orderedSubsequenceSpan, pinyinFirstLetters } from "@/lib/common/pinyin";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { driverProfileCompletionObjects, driverProfileCompletionTableMetadata, driverProfileCompletionTables, driverProfileRoutineSignatures } from "@/lib/database/driverProfileExtensions";

export { DEFAULT_SQL_SNIPPETS, resolveSqlSnippetBodyForDatabase } from "@/lib/sql/sqlSnippetTemplates";

const SQLSERVER_DEFAULT_SCHEMA = "dbo";

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
  "REPEAT",
  "DATABASE",
  "SCHEMA",
  "USER",
  "CURRENT_USER",
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

function isTableTriggerKeyword(keyword: string, options: SqlSemanticBuildOptions): boolean {
  return TABLE_TRIGGER_KEYWORDS.has(keyword) || (keyword === "desc" && resolveSqlDialectId(options) === "mysql");
}

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
    ["CURRENT_DATE", d.CURRENT_DATE || "Returns the current date"],
    ["CURRENT_TIME", d.CURRENT_TIME || "Returns the current time"],
    ["CURRENT_TIMESTAMP", d.CURRENT_TIMESTAMP || "Returns the current date and time"],
    ["CURDATE", d.CURDATE || "Returns the current date"],
    ["CURTIME", d.CURTIME || "Returns the current time"],
    ["LOCALTIME", d.LOCALTIME || "Returns the current local time"],
    ["LOCALTIMESTAMP", d.LOCALTIMESTAMP || "Returns the current local date and time"],
    ["UTC_DATE", d.UTC_DATE || "Returns the current UTC date"],
    ["UTC_TIME", d.UTC_TIME || "Returns the current UTC time"],
    ["UTC_TIMESTAMP", d.UTC_TIMESTAMP || "Returns the current UTC date and time"],
    ["SYSDATE", d.SYSDATE || "Returns the current date and time"],
    ["DATE", d.DATE || "Extracts the date part"],
    ["TIME", d.TIME || "Extracts the time part"],
    ["TIMESTAMPDIFF", d.TIMESTAMPDIFF || "Returns the difference between two datetimes"],
    ["YEAR", d.YEAR || "Extracts the year"],
    ["MONTH", d.MONTH || "Extracts the month"],
    ["DAY", d.DAY || "Extracts the day"],
    ["HOUR", d.HOUR || "Extracts the hour"],
    ["MINUTE", d.MINUTE || "Extracts the minute"],
    ["SECOND", d.SECOND || "Extracts the second"],
    ["DAYOFWEEK", d.DAYOFWEEK || "Returns the weekday index"],
    ["DAYOFYEAR", d.DAYOFYEAR || "Returns the day of year"],
    ["LAST_DAY", d.LAST_DAY || "Returns the last day of the month"],
    ["STR_TO_DATE", d.STR_TO_DATE || "Converts a string to a date"],
    ["IF", d.IF || "Returns a value based on a condition"],
    ["LEFT", d.LEFT || "Returns the leftmost characters"],
    ["RIGHT", d.RIGHT || "Returns the rightmost characters"],
    ["SUBSTRING_INDEX", d.SUBSTRING_INDEX || "Returns a substring before a delimiter count"],
    ["CHAR_LENGTH", d.CHAR_LENGTH || "Returns the character length"],
    ["INSTR", d.INSTR || "Returns the position of a substring"],
    ["LOCATE", d.LOCATE || "Returns the position of a substring"],
    ["LPAD", d.LPAD || "Left-pads a string to a length"],
    ["RPAD", d.RPAD || "Right-pads a string to a length"],
    ["FIND_IN_SET", d.FIND_IN_SET || "Returns the index in a comma-separated list"],
    ["RAND", d.RAND || "Returns a random floating-point value"],
    ["MD5", d.MD5 || "Returns the MD5 hash"],
    ["SHA1", d.SHA1 || "Returns the SHA1 hash"],
    ["SHA2", d.SHA2 || "Returns the SHA2 hash"],
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
  ["DATE_ADD", ["date", "INTERVAL expr unit"]],
  ["DATE_SUB", ["date", "INTERVAL expr unit"]],
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
  ["VERSION", []],
  ["SYSDATE", []],
  ["CURRENT_DATE", []],
  ["CURRENT_TIME", []],
  ["CURRENT_TIMESTAMP", []],
  ["CURDATE", []],
  ["CURTIME", []],
  ["LOCALTIME", []],
  ["LOCALTIMESTAMP", []],
  ["UTC_DATE", []],
  ["UTC_TIME", []],
  ["UTC_TIMESTAMP", []],
  ["DATE", ["expression"]],
  ["TIME", ["expression"]],
  ["DATE_ADD", ["date", "INTERVAL expr unit"]],
  ["DATE_SUB", ["date", "INTERVAL expr unit"]],
  ["DATEDIFF", ["date1", "date2"]],
  ["TIMESTAMPDIFF", ["unit", "datetime_expr1", "datetime_expr2"]],
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
  ["MONTHNAME", ["date"]],
  ["DAYOFMONTH", ["date"]],
  ["WEEKDAY", ["date"]],
  ["WEEK", ["date", "mode"]],
  ["QUARTER", ["date"]],
  ["ADDDATE", ["date", "days"]],
  ["SUBDATE", ["date", "days"]],
  ["ADDTIME", ["datetime", "time"]],
  ["SUBTIME", ["datetime", "time"]],
  ["TIMEDIFF", ["datetime1", "datetime2"]],
  ["FROM_DAYS", ["day_number"]],
  ["TO_DAYS", ["date"]],
  ["MAKEDATE", ["year", "day_of_year"]],
  ["MAKETIME", ["hour", "minute", "second"]],
  ["IFNULL", ["expression", "fallback"]],
  ["IF", ["condition", "true_value", "false_value"]],
  ["CONCAT_WS", ["separator", "...values"]],
  ["LEFT", ["string", "length"]],
  ["RIGHT", ["string", "length"]],
  ["SUBSTRING_INDEX", ["string", "delimiter", "count"]],
  ["CHAR_LENGTH", ["string"]],
  ["INSTR", ["string", "substring"]],
  ["LOCATE", ["substring", "string"]],
  ["LPAD", ["string", "length", "pad"]],
  ["RPAD", ["string", "length", "pad"]],
  ["REVERSE", ["string"]],
  ["POSITION", ["substring", "string"]],
  ["REPEAT", ["string", "count"]],
  ["STRCMP", ["string1", "string2"]],
  ["FIND_IN_SET", ["string", "string_list"]],
  ["ELT", ["index", "string1", "...strings"]],
  ["FIELD", ["value", "value1", "...values"]],
  ["MAKE_SET", ["bits", "string1", "...strings"]],
  ["RAND", []],
  ["POW", ["base", "exponent"]],
  ["EXP", ["number"]],
  ["LN", ["number"]],
  ["LOG", ["base", "number"]],
  ["LOG10", ["number"]],
  ["LOG2", ["number"]],
  ["SIN", ["number"]],
  ["PI", []],
  ["COS", ["number"]],
  ["TAN", ["number"]],
  ["ASIN", ["number"]],
  ["ACOS", ["number"]],
  ["ATAN", ["number"]],
  ["ATAN2", ["y", "x"]],
  ["DEGREES", ["radians"]],
  ["RADIANS", ["degrees"]],
  ["BIN", ["number"]],
  ["HEX", ["value"]],
  ["UNHEX", ["string"]],
  ["OCT", ["number"]],
  ["CONV", ["number", "from_base", "to_base"]],
  ["TRUNCATE", ["number", "decimals"]],
  ["MD5", ["string"]],
  ["SHA1", ["string"]],
  ["SHA2", ["string", "bit_length"]],
  ["JSON_EXTRACT", ["json", "path"]],
  ["JSON_UNQUOTE", ["json"]],
  ["JSON_OBJECT", ["key", "value", "...pairs"]],
  ["JSON_ARRAY", ["...values"]],
  ["JSON_SET", ["json", "path", "value", "...path_value_pairs"]],
  ["JSON_INSERT", ["json", "path", "value", "...path_value_pairs"]],
  ["JSON_REPLACE", ["json", "path", "value", "...path_value_pairs"]],
  ["JSON_REMOVE", ["json", "path", "...paths"]],
  ["JSON_CONTAINS", ["target", "candidate"]],
  ["JSON_LENGTH", ["json"]],
  ["GROUP_CONCAT", ["expression"]],
  ["PASSWORD", ["string"]],
  ["DATABASE", []],
  ["SCHEMA", []],
  ["USER", []],
  ["CURRENT_USER", []],
  ["COLLATION", ["string"]],
  ["FOUND_ROWS", []],
  ["LAST_INSERT_ID", []],
  ["BENCHMARK", ["count", "expression"]],
  ["SLEEP", ["seconds"]],
  ["UUID", []],
  ["UUID_SHORT", []],
  ["NOW", []],
]);

/** Keywords that may also exist as built-in functions; keep both completion entries. */
const DUAL_ROLE_SQL_KEYWORDS = new Set(["LEFT", "RIGHT", "IF", "TRUNCATE", "REPEAT", "DATABASE", "SCHEMA", "USER", "CURRENT_USER"]);

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

const SQLSERVER_DATEPART_FUNCTIONS = new Set(["DATEADD", "DATEDIFF", "DATEPART", "DATENAME"]);
const SQLSERVER_DATEPART_VALUES = ["year", "quarter", "month", "dayofyear", "day", "week", "weekday", "hour", "minute", "second", "millisecond", "microsecond", "nanosecond", "tzoffset", "iso_week"];

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

const MYSQL_FUNCTION_APPLY_TEMPLATES = new Map<string, string>([
  ["DATE_ADD", "DATE_ADD(${date}, INTERVAL ${expr} ${unit})"],
  ["DATE_SUB", "DATE_SUB(${date}, INTERVAL ${expr} ${unit})"],
  ["POSITION", "POSITION(${substring} IN ${string})"],
]);

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
  catalog?: string;
  database?: string;
  schema?: string;
  type?: SqlObjectNavigationType;
  tableType?: string;
  detail?: string;
  applyName?: string;
  boost?: number;
}

export interface SqlCompletionObject {
  name: string;
  schema?: string;
  type: "procedure" | "function" | "trigger" | "package" | "sequence";
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
  sourceQualifierSql?: string;
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

export type SqlCompletionClosingQuote = '"' | "'" | "`" | "]";

export interface SqlCompletionItem {
  label: string;
  filterText?: string;
  type: "keyword" | "table" | "column" | "snippet" | "function" | "schema" | "variable" | "text";
  detail?: string;
  info?: string | ((completion: Completion) => CompletionInfo | Promise<CompletionInfo>);
  apply?: string;
  replaceClosingQuote?: SqlCompletionClosingQuote;
  boost: number;
  exactMatch?: boolean;
  dedupeKey?: string;
}

export function shouldChainSqlCompletionAfterAccept(item: { type?: string; apply?: string }): boolean {
  return item.type === "schema" && item.apply?.endsWith(".") === true;
}

export type SqlKeywordCase = "preserve" | "upper" | "lower";

type SqlCompletionApplyDialect = "mysql" | "postgres" | "sqlserver" | "oracle" | "upper";

// QueryEditor may use another dialect as a CodeMirror syntax fallback.
// Completion apply text must still follow the connected database's identifier
// folding and quoting rules.
const MYSQL_LIKE_IDENTIFIER_DATABASES = new Set<DatabaseType>(["mysql", "clickhouse", "hive", "kyuubi", "impala", "spark", "databend", "tdengine", "access", "doris", "starrocks"]);
const POSTGRES_LIKE_IDENTIFIER_DATABASES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kingbase", "highgo", "uxdb", "vastbase", "kwdb", "opengauss"]);
const ORACLE_COMPAT_IDENTIFIER_DATABASES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "yashandb", "oscar", "xugu"]);
const UPPER_FOLDING_IDENTIFIER_DATABASES = new Set<DatabaseType>(["dameng", "db2"]);

function sqlCompletionApplyDialect(databaseType: DatabaseType | undefined, fallback: "mysql" | "postgres" | "sqlserver" | undefined): SqlCompletionApplyDialect | undefined {
  if (!databaseType) return fallback;
  if (MYSQL_LIKE_IDENTIFIER_DATABASES.has(databaseType)) return "mysql";
  if (POSTGRES_LIKE_IDENTIFIER_DATABASES.has(databaseType)) return "postgres";
  if (ORACLE_COMPAT_IDENTIFIER_DATABASES.has(databaseType)) return "oracle";
  if (UPPER_FOLDING_IDENTIFIER_DATABASES.has(databaseType)) return "upper";
  if (databaseType === "sqlserver") return "sqlserver";
  return fallback;
}

export interface SqlCompletionReferencedTable {
  name: string;
  nameQuoted?: boolean;
  database?: string;
  schema?: string;
  schemaQuoted?: boolean;
  alias?: string;
  aliasSql?: string;
  columns?: string[];
  columnAliases?: string[];
}

export type SqlStatementKind = "select" | "insert" | "update" | "delete" | "create" | "alter" | "drop" | "unknown";

export type SqlCompletionContextKind = "table" | "schema" | "catalog" | "routine" | "column" | "alias_column" | "insert_target" | "update_target" | "exec" | "join" | "keyword";

export interface SqlCompletionContext {
  prefix: string;
  replacementRange?: { start: number; end: number };
  preferredValueKeywords?: string[];
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
  insertDatabase?: string;
  insertSchema?: string;
  statementKind: SqlStatementKind;
  tableTriggerWord?: string;
  isGroupBy: boolean;
  isEmptyGroupBy: boolean;
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
  openingParenAfterCursor: boolean;
  contextKind: SqlCompletionContextKind;
  dataTypeContext: boolean;
}

const SQL_COMPLETION_CLOSING_QUOTES: Readonly<Record<string, SqlCompletionClosingQuote>> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "[": "]",
};

export function prepareSqlCompletionReplacement(sql: string, cursor: number, context: Pick<SqlCompletionContext, "prefix" | "qualifier" | "replacementRange">, items: SqlCompletionItem[]): { from: number; items: SqlCompletionItem[] } {
  const range = context.replacementRange;
  const from = range && range.start >= 0 && range.start <= cursor && range.end === cursor ? range.start : cursor - context.prefix.length;
  const closingQuote = from < cursor ? SQL_COMPLETION_CLOSING_QUOTES[sql[from] ?? ""] : undefined;
  if (!closingQuote) return { from, items };
  const replaceClosingQuote = sql[cursor] === closingQuote ? closingQuote : undefined;
  return {
    from,
    items: items.map((item) => {
      let prepared = item;
      const apply = item.apply ?? item.label;
      if (item.type === "column" && !(apply.startsWith(sql[from] ?? "") && apply.endsWith(closingQuote)) && (context.qualifier || !apply.includes("."))) {
        const escaped = apply.replaceAll(closingQuote, closingQuote + closingQuote);
        prepared = { ...prepared, apply: `${sql[from]}${escaped}${closingQuote}` };
      }
      return replaceClosingQuote && !prepared.replaceClosingQuote ? { ...prepared, replaceClosingQuote } : prepared;
    }),
  };
}

export interface PostgresSequenceLiteralCompletionContext {
  from: number;
  prefix: string;
  schema?: string;
  schemaQuoted: boolean;
  nameQuoted: boolean;
  nameQuoteClosed: boolean;
}

export interface SqlFunctionSignatureHelpOverload {
  signature: string;
  parameterGroups: string[][];
  activeGroup: number;
  activeParameter: number;
}

export interface SqlFunctionSignatureHelp {
  name: string;
  overloads: SqlFunctionSignatureHelpOverload[];
  activeOverload: number;
  /** Legacy single-overload fields retained for non-ClickHouse callers. */
  signature?: string;
  activeParameter?: number;
  parameters?: string[];
}

export interface SqlCompletionTranslations {
  nullValue: string;
  isNull: string;
  isNotNull: string;
  stringLiteral: string;
  numericLiteral: string;
  booleanValue: string;
  starExpansionColumns: string;
  tableAlias: string;
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
  driverProfile?: string;
  currentSchema?: string;
  keywordCase?: SqlKeywordCase;
  functionCase?: SqlKeywordCase;
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
    driverProfile?: string;
    currentSchema?: string;
    keywordCase?: SqlKeywordCase;
    functionCase?: SqlKeywordCase;
    autoAliasTables?: boolean;
  },
): SqlCompletionItem[] {
  if (isSqlCompletionSuppressedContext(sql, cursor, input)) return [];
  const context = getSqlCompletionContext(sql, cursor, input);
  return buildSqlCompletionItemsFromContext(context, input);
}

export function buildSqlCompletionItemsFromContext(context: SqlCompletionContext, input: SqlCompletionProviderInput): SqlCompletionItem[] {
  return new SqlCompletionProvider(context, input).build();
}

class SqlCompletionProvider {
  private readonly items: SqlCompletionItem[] = [];
  private readonly t?: SqlCompletionTranslations;
  private readonly dialect?: SqlCompletionApplyDialect;
  private readonly databaseType?: DatabaseType;

  constructor(
    private readonly context: SqlCompletionContext,
    private readonly input: SqlCompletionProviderInput,
  ) {
    this.t = input.translations;
    this.dialect = sqlCompletionApplyDialect(input.databaseType, input.dialect);
    this.databaseType = input.databaseType;
  }

  build(): SqlCompletionItem[] {
    const { context } = this;
    const pendingJoinKeyword = isPendingJoinKeywordContext(context);
    const completionTables = [
      ...this.input.tables.map((table) => {
        const metadata = driverProfileCompletionTableMetadata(this.input.driverProfile, table.name);
        if (!metadata) return table;
        return {
          ...table,
          detail: table.detail ?? metadata.detail,
          boost: (table.boost ?? 0) + (metadata.boost ?? 0),
        };
      }),
      ...driverProfileCompletionTables(this.input.driverProfile, context),
    ];

    if (this.databaseType === "mongodb") {
      return dedupeAndSort(buildMongoCompletionItemsFromContext({ mode: "root", prefix: context.prefix, from: 0 }).map(mongoCompletionItemToSqlCompletionItem));
    }

    if (context.preferredValueKeywords?.length) {
      return dedupeAndSort(buildPreferredKeywordItems(context.prefix, context.preferredValueKeywords, this.input.keywordCase));
    }

    const preferReferencedColumns = hasMatchingReferencedColumnPrefix(context, this.input.columnsByTable);
    if (!pendingJoinKeyword && !context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions) {
      const snippets = this.databaseType === "manticoresearch" ? [...(this.input.snippets ?? DEFAULT_SQL_SNIPPETS), ...MANTICORESEARCH_SQL_SNIPPETS] : (this.input.snippets ?? DEFAULT_SQL_SNIPPETS);
      if (!preferReferencedColumns) {
        this.items.push(...buildSnippetItems(context.prefix, snippets, this.input.keywordCase, this.databaseType));
      }
      if (!preferReferencedColumns || context.suggestRoutines) {
        const functionItems = context.dataTypeContext ? [] : buildFunctionSnippetItems(context.prefix, getFunctionDescriptions(this.t), this.databaseType, context.openingParenAfterCursor, this.input.keywordCase, this.input.functionCase);
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
          this.databaseType,
        ),
      );
    }

    if (context.preferredKeywords.length > 0) {
      this.items.push(...buildPreferredKeywordItems(context.prefix, context.preferredKeywords, this.input.keywordCase));
    }

    if (!pendingJoinKeyword && context.suggestColumns && !context.qualifier && !context.insertTable && context.prefix) {
      this.items.push(...buildReferencedAliasItems(context, this.t));
    }

    if (!context.exclusiveTableSuggestions && !context.exclusiveColumnSuggestions && !context.exclusiveRoutineSuggestions && context.prioritizeSelectAliases) {
      const selectAliasItems = buildSelectAliasItems(context);
      this.items.push(...selectAliasItems);
      if (context.isEmptyGroupBy && !context.prefix) {
        const allSelectAliasesItem = buildGroupByAllSelectAliasItem(context, selectAliasItems, this.input.columnsByTable, this.dialect);
        if (allSelectAliasesItem) this.items.push(allSelectAliasesItem);
      }
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
      this.items.push(...buildSelectAllColumnItems(context, this.input.columnsByTable, this.t, this.dialect, this.databaseType));
      this.items.push(...buildInsertAllColumnItems(context, this.input.columnsByTable, this.t, this.dialect, this.input.keywordCase));
    }

    const emptyTableNameCompletion = !context.prefix && (context.suggestTables || context.exclusiveTableSuggestions);
    if (!pendingJoinKeyword && !emptyTableNameCompletion && !context.tableAliasAfterCursor && context.referencedTables.length > 0 && !context.suggestColumns && !context.insertTable) {
      this.items.push(...buildAliasItems(context, this.databaseType, this.input.keywordCase));
    }

    if (!context.exclusiveColumnSuggestions && context.suggestTables) {
      this.items.push(...buildForeignKeyRelatedTableItems(context, completionTables, this.input.foreignKeysByTable, this.dialect, !!this.input.autoAliasTables && context.autoAliasTableCompletions, this.databaseType, this.input.keywordCase, this.input.currentSchema));
      this.items.push(...buildTableItems(context, completionTables, this.dialect, !!this.input.autoAliasTables && context.autoAliasTableCompletions, context.referencedTables, this.databaseType, this.input.currentSchema, this.input.keywordCase));
      if (this.databaseType === "clickhouse") {
        this.items.push(...buildClickHouseFunctionItems(context.prefix, context.openingParenAfterCursor, "table"));
      }
      if (isOracleLikeDatabase(this.databaseType)) {
        this.items.push(...buildOracleTableFunctionItems(context.prefix, this.input.keywordCase, this.input.functionCase));
      }
      if (this.input.schemas && this.input.schemas.length > 0) {
        this.items.push(...buildSchemaItems(context.prefix, this.input.schemas, this.dialect));
      }
    }

    if (context.suggestRoutines || context.exclusiveRoutineSuggestions || context.oracleTableFunctionContext) {
      const profileObjects = driverProfileCompletionObjects(this.input.driverProfile, context);
      this.items.push(...buildObjectItems(context, [...(this.input.objects ?? []), ...profileObjects], this.dialect, this.databaseType, this.input.currentSchema));
    }

    if (context.comparisonLeftColumn && context.suggestKeywords) {
      this.items.push(...buildComparisonValueItems(context, this.input.columnsByTable, this.t, this.input.keywordCase));
    }

    if (context.onStar) {
      const starItem = buildStarExpansionItem(context, this.input.columnsByTable, this.t, this.dialect, this.databaseType);
      if (starItem) this.items.push(starItem);
    }

    if (context.prefix) {
      for (const item of this.items) {
        // Alias snippets reuse the prefix as a label while applying alias SQL, so they are not exact name matches.
        const isAliasSnippet = item.type === "snippet" && item.apply === formatAliasCompletionApply(item.label, this.databaseType, this.input.keywordCase);
        const isExactLabelMatch = !isAliasSnippet && item.label.toLowerCase() === context.prefix.toLowerCase();
        const isExactFilterTextMatch = item.filterText?.toLowerCase() === context.prefix.toLowerCase();
        if (isExactLabelMatch || isExactFilterTextMatch) {
          item.exactMatch = true;
          item.boost += EXACT_LABEL_MATCH_BOOST;
        }
      }
    }

    return dedupeAndSort(this.items);
  }
}

export function shouldAutoOpenSqlCompletion(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): boolean {
  if (getPostgresSequenceLiteralCompletionContext(sql, cursor, options.databaseType)) return true;
  if (isSqlCompletionSuppressedContext(sql, cursor, options)) return false;
  const previousChar = sql[cursor - 1];
  if (!previousChar) return false;
  if (/\bon\s+$/i.test(sql.slice(0, cursor))) return true;
  if (isAfterJoinModifierContext(sql.slice(0, cursor), options.databaseType)) return true;
  if (/\bcall\s+(?:[A-Za-z_][\w$]*\.)?$/i.test(sql.slice(0, cursor))) return true;
  const context = getSqlCompletionContext(sql, cursor, options);
  if (previousChar === "(" && (context.insertTable || context.preferredValueKeywords?.length)) return true;
  if (/[,;()[\]]/.test(previousChar)) return false;
  if (context.exclusiveTableSuggestions || context.exclusiveRoutineSuggestions || context.suggestTables) {
    return true;
  }
  if (context.exclusiveColumnSuggestions || shouldAutoOpenColumnCompletion(context, sql, cursor, options.databaseType)) return true;
  return /[A-Za-z_$@.]/.test(previousChar);
}

function shouldAutoOpenColumnCompletion(context: SqlCompletionContext, sql: string, cursor: number, databaseType: DatabaseType | undefined): boolean {
  if (!context.suggestColumns || context.referencedTables.length === 0) return false;
  if (context.prefix.length > 0) return true;
  return isColumnCompletionExpressionStart(sql.slice(0, cursor), databaseType);
}

function isColumnCompletionExpressionStart(beforeCursor: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeCursor, databaseType).trimEnd();
  if (!cleaned) return false;
  return /(?:\b(?:where|on|having|and|or|not|is|like|in|between|by)\b|[,(])$/i.test(cleaned);
}

export function isSqlCompletionSuppressedContext(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): boolean {
  const context = getSqlLexicalContext(sql, cursor, options);
  return context.inLineComment || context.inBlockComment || context.inStringLiteral;
}

/**
 * Resolves the statement window backing a boundary-sensitive lookup, preferring CodeMirror's own
 * incrementally-parsed syntax tree (see sqlSyntaxTreeWindow.ts) when the caller has a live,
 * plausibly-matching `EditorState`, and falling back to the bounded heuristic scanner in
 * insertValueHints.ts otherwise -- e.g. pure-string test/utility callers, or a live editor whose
 * background parse hasn't caught up to `cursor` yet. The tree path never blocks and is never worse
 * than the scanner; see sqlSyntaxTreeWindow.ts's doc comment for the one known, disclosed gap
 * (dollar-quoted bodies, guarded rather than silently trusted).
 */
export function getPostgresSequenceLiteralCompletionContext(sql: string, cursor: number, databaseType?: DatabaseType): PostgresSequenceLiteralCompletionContext | null {
  if (databaseType !== "postgres") return null;
  const position = Math.max(0, Math.min(cursor, sql.length));
  const literalStart = activeSingleQuotedLiteralStart(sql, position);
  if (literalStart == null) return null;

  const beforeLiteral = sql.slice(0, literalStart);
  if (!isPostgresSequenceFunctionCall(beforeLiteral)) return null;

  const rawLiteral = sql.slice(literalStart + 1, position);
  const parsed = parsePostgresRegclassPrefix(rawLiteral);
  if (!parsed) return null;
  return {
    from: literalStart + 1 + parsed.nameStart,
    prefix: parsed.name,
    schema: parsed.schema,
    schemaQuoted: parsed.schemaQuoted,
    nameQuoted: parsed.nameQuoted,
    nameQuoteClosed: parsed.nameQuoteClosed,
  };
}

export function buildPostgresSequenceLiteralCompletionItems(context: PostgresSequenceLiteralCompletionContext, objects: SqlCompletionObject[]): SqlCompletionItem[] {
  return objects
    .filter((object) => object.type === "sequence")
    .filter((object) => {
      if (context.schema) {
        if (!object.schema) return false;
        const schemaMatches = context.schemaQuoted ? object.schema === context.schema : object.schema.toLowerCase() === context.schema.toLowerCase();
        if (!schemaMatches) return false;
      }
      return context.nameQuoted ? object.name.startsWith(context.prefix) : object.name.toLowerCase().startsWith(context.prefix.toLowerCase());
    })
    .map((object) => {
      const identifier = context.nameQuoted ? `${escapePostgresSequenceLiteralQuotedIdentifier(object.name)}"` : escapePostgresSequenceLiteralIdentifier(quoteSqlIdentifier(object.name, "postgres"));
      return {
        label: object.name,
        filterText: context.nameQuoted ? identifier.slice(0, -1) : escapePostgresSequenceLiteralIdentifier(object.name),
        type: "variable" as const,
        detail: object.schema ? `sequence in ${object.schema}` : "sequence",
        info: object.comment?.trim() || undefined,
        apply: identifier,
        replaceClosingQuote: context.nameQuoted && !context.nameQuoteClosed ? ('"' as const) : undefined,
        boost: computeBoost(object.name, context.prefix) + 1_200,
      };
    })
    .sort(compareCompletionItems)
    .slice(0, MAX_TABLE_COMPLETION_ITEMS);
}

function escapePostgresSequenceLiteralIdentifier(value: string): string {
  return value.replaceAll("'", "''");
}

function escapePostgresSequenceLiteralQuotedIdentifier(value: string): string {
  return escapePostgresSequenceLiteralIdentifier(value.replaceAll('"', '""'));
}

function isPostgresSequenceFunctionCall(beforeLiteral: string): boolean {
  const call = /(?:nextval|currval|setval)\s*\(\s*$/i.exec(beforeLiteral);
  if (!call) return false;

  const beforeFunction = beforeLiteral.slice(0, call.index);
  const beforeFunctionTrimmed = beforeFunction.trimEnd();
  if (!beforeFunctionTrimmed.endsWith(".")) {
    return !beforeFunction || /\s$/.test(beforeFunction) || !/[\w$."`]$/.test(beforeFunction);
  }

  const beforeDot = beforeFunctionTrimmed.slice(0, -1).trimEnd();
  const qualifier = /(?:"((?:""|[^"])*)"|([A-Za-z_][\w$]*))$/.exec(beforeDot);
  if (!qualifier) return false;
  const quotedQualifier = qualifier[1];
  const qualifierName = (quotedQualifier ?? qualifier[2] ?? "").replaceAll('""', '"');
  if (quotedQualifier != null ? qualifierName !== "pg_catalog" : qualifierName.toLowerCase() !== "pg_catalog") return false;
  const beforeQualifier = beforeDot.slice(0, qualifier.index);
  return !beforeQualifier || /\s$/.test(beforeQualifier) || !/[\w$."`]$/.test(beforeQualifier);
}

function activeSingleQuotedLiteralStart(sql: string, cursor: number): number | null {
  let literalStart: number | null = null;
  let dollarQuoteDelimiter: string | null = null;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < cursor; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (dollarQuoteDelimiter) {
      if (sql.startsWith(dollarQuoteDelimiter, index)) {
        index += dollarQuoteDelimiter.length - 1;
        dollarQuoteDelimiter = null;
      }
      continue;
    }
    if (inLineComment) {
      if (char === "\n" || char === "\r") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (literalStart != null) {
      if (char === "'" && next === "'") {
        index++;
      } else if (char === "'") {
        literalStart = null;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"' && next === '"') index++;
      else if (char === '"') inDoubleQuote = false;
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
    } else if (char === '"') {
      inDoubleQuote = true;
    } else if (char === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index, cursor))?.[0];
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        index += delimiter.length - 1;
      }
    } else if (char === "'") {
      literalStart = index;
    }
  }
  return literalStart;
}

function parsePostgresRegclassPrefix(raw: string): { nameStart: number; name: string; schema?: string; schemaQuoted: boolean; nameQuoted: boolean; nameQuoteClosed: boolean } | null {
  const parts: Array<{ start: number; value: string; quoted: boolean; quoteClosed: boolean }> = [];
  let index = 0;
  while (index < raw.length && /\s/.test(raw[index] ?? "")) index++;
  while (index <= raw.length && parts.length < 2) {
    const start = index;
    let quoted = false;
    let quoteClosed = false;
    let value = "";
    if (raw[index] === '"') {
      quoted = true;
      index++;
      const valueStart = index;
      while (index < raw.length) {
        const char = raw[index] ?? "";
        if (char === '"' && raw[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (char === '"') {
          quoteClosed = true;
          index++;
          break;
        } else if (char === "'" && raw[index + 1] === "'") {
          value += "'";
          index += 2;
        } else {
          value += char;
          index++;
        }
      }
      parts.push({ start: valueStart, value, quoted, quoteClosed });
    } else {
      while (index < raw.length && raw[index] !== ".") {
        const char = raw[index] ?? "";
        if (char === "'" && raw[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (/\s/.test(char) || char === '"') {
          return null;
        } else {
          value += char;
          index++;
        }
      }
      parts.push({ start, value, quoted, quoteClosed });
    }
    if (index >= raw.length) break;
    if (raw[index] !== "." || (!quoteClosed && quoted)) return null;
    index++;
    if (index >= raw.length) parts.push({ start: index, value: "", quoted: false, quoteClosed: false });
  }
  if (index < raw.length || parts.length === 0 || parts.length > 2) return null;
  const name = parts[parts.length - 1]!;
  const schema = parts.length === 2 ? parts[0] : undefined;
  return {
    nameStart: name.start,
    name: name.value,
    schema: schema?.value ? (schema.quoted ? schema.value : schema.value.toLowerCase()) : undefined,
    schemaQuoted: schema?.quoted ?? false,
    nameQuoted: name.quoted,
    nameQuoteClosed: name.quoteClosed,
  };
}

export function isSqlStringLiteralContext(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): boolean {
  return getSqlLexicalContext(sql, cursor, options).inStringLiteral;
}

export function isSqlCommentContext(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): boolean {
  const context = getSqlLexicalContext(sql, cursor, options);
  return context.inLineComment || context.inBlockComment;
}

function getSqlLexicalContext(sql: string, cursor: number, options: SqlSemanticBuildOptions): { inLineComment: boolean; inBlockComment: boolean; inStringLiteral: boolean } {
  const end = Math.max(0, Math.min(cursor, sql.length));
  const editorState = options.editorState;
  if (editorState && isEditorStatePlausibleFor(editorState, sql)) {
    const treeContext = resolveLexicalLeafFromSyntaxTree(editorState, end);
    if (treeContext) return treeContext;
  }
  const dialectId = resolveSqlDialectId(options);
  // Bound the backward scan so huge documents do not pay O(document) on every keystroke (this
  // runs on every completion request). expandToSqlStatementWindow's `from` is verified rather
  // than assumed clean (it widens its own backward scan until the boundary is confirmed, or
  // grounds at the true document start), so scanning forward from it here is safe.
  const start = expandToSqlStatementWindow(sql, end, end, dialectId).from;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  for (let index = start; index < end; index += 1) {
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

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
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
    } else if (ch === "#" && dialectId === "mysql") {
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
    } else if (ch === "$") {
      const marker = matchDollarQuoteTag(sql, index);
      if (marker) {
        dollarTag = marker;
        index += marker.length - 1;
      }
    }
  }

  // Only single-quoted and dollar-quoted text is a value literal here. Double quotes,
  // backticks, and brackets delimit identifiers in common SQL dialects, so they must not
  // suppress identifier completion.
  return {
    inLineComment,
    inBlockComment,
    inStringLiteral: inSingleQuote || dollarTag !== null,
  };
}

export function isSqlLikeCompletionStatement(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): boolean {
  const activeStatementSpan = activeSqlCompletionStatementSpan(sql, cursor, options);
  const lineBlock = currentSqlLikeLineBlockSpan(sql, cursor, activeStatementSpan);
  const statementSpan = lineBlock ?? activeStatementSpan;
  const statement = sql.slice(statementSpan.start, statementSpan.end).trimStart();
  if (/^(select|with)\b/i.test(statement)) return true;
  return lineBlock != null;
}

function activeSqlCompletionStatementSpan(sql: string, cursor: number, options: SqlSemanticBuildOptions): SqlSemanticSpan {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  const dialectId = resolveSqlDialectId(options);
  // Tokenizing the full document on every keystroke is O(document) and, with
  // autocompletion's activateOnTyping, runs on every keystroke. Bound tokenization
  // to the statement window around the cursor (preferring the live syntax tree, see
  // resolveSqlStatementWindow) and translate spans back. Pass dialectId through so the
  // window boundary agrees with tokenizeSqlSemantic below on dialect-sensitive lexing
  // (e.g. '#' as a MySQL comment vs a PostgreSQL operator) when falling back to the scanner.
  const window = resolveSqlStatementWindow(sql, safeCursor, options.editorState, dialectId);
  const windowSql = sql.slice(window.from, window.to);
  const windowCursor = safeCursor - window.from;
  const tokens = tokenizeSqlSemantic(windowSql, dialectId);
  const statementSpan = findActiveSqlStatementSpan(windowSql, tokens, windowCursor);
  const firstStatementToken = tokens.find((token) => token.kind !== "comment" && token.span.end > statementSpan.start && token.span.start < statementSpan.end);
  const result = firstStatementToken ? { start: firstStatementToken.span.start, end: statementSpan.end } : statementSpan;
  return { start: result.start + window.from, end: result.end + window.from };
}

function currentSqlLikeLineBlockSpan(sql: string, cursor: number, activeStatementSpan: SqlSemanticSpan): SqlSemanticSpan | null {
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
  if (activeStatementSpan.start > start) return null;

  const blockEnd = currentLineBlockEnd(sql, safeCursor, start);
  return { start, end: blockEnd == null ? activeStatementSpan.end : Math.min(activeStatementSpan.end, blockEnd) };
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

export function getSqlFunctionSignatureHelp(sql: string, cursor: number, databaseType?: DatabaseType, driverProfile?: string): SqlFunctionSignatureHelp | null {
  const beforeCursor = sql.slice(0, cursor);
  const call = findActiveFunctionCall(beforeCursor);
  if (!call) return null;

  const observedParameter = countTopLevelCommas(call.groupText);
  if (databaseType !== "clickhouse") {
    const lookupName = call.name.toUpperCase();
    const parameters = activeFunctionSignatures(databaseType).get(lookupName) ?? driverProfileRoutineSignatures(driverProfile).get(lookupName);
    if (!parameters) return null;
    const activeParameter = Math.min(observedParameter, Math.max(0, parameters.length - 1));
    const signature = `${lookupName}(${parameters.join(", ")})`;
    const legacyHelp = { name: lookupName, signature, activeParameter, parameters };
    Object.defineProperties(legacyHelp, {
      overloads: {
        value: [{ signature, parameterGroups: [parameters], activeGroup: 0, activeParameter }],
        enumerable: false,
      },
      activeOverload: { value: 0, enumerable: false },
    });
    return legacyHelp as SqlFunctionSignatureHelp;
  }

  const parameterGroups = searchClickHouseFunctions(call.name, 50)
    .find((definition) => [definition.name, ...(definition.aliases ?? [])].some((name) => name.toLowerCase() === call.name.toLowerCase()))
    ?.signatures.map((signature) => signature.parameterGroups);
  if (!parameterGroups) return null;

  const overloads = parameterGroups
    .map((groups, sourceIndex) => ({ groups, sourceIndex }))
    .filter(({ groups }) => groups[call.activeGroup] != null)
    .sort((left, right) => {
      const leftAccepts = functionParameterGroupAccepts(left.groups[call.activeGroup], observedParameter);
      const rightAccepts = functionParameterGroupAccepts(right.groups[call.activeGroup], observedParameter);
      return Number(rightAccepts) - Number(leftAccepts) || left.sourceIndex - right.sourceIndex;
    })
    .map(({ groups }) => {
      const parameters = groups[call.activeGroup];
      return {
        signature: call.name + groups.map((group) => `(${group.join(", ")})`).join(""),
        parameterGroups: groups,
        activeGroup: call.activeGroup,
        activeParameter: Math.min(observedParameter, Math.max(0, parameters.length - 1)),
      };
    });
  if (overloads.length === 0) return null;

  return {
    name: call.name,
    overloads,
    activeOverload: 0,
  };
}

function functionParameterGroupAccepts(parameters: string[], observedParameter: number): boolean {
  if (observedParameter < parameters.length) return true;
  return parameters.some((parameter) => parameter.startsWith("..."));
}

function sqlCompletionStatementSpan(sql: string, cursor: number, options: SqlSemanticBuildOptions): SqlSemanticSpan {
  const activeStatementSpan = activeSqlCompletionStatementSpan(sql, cursor, options);
  return currentSqlLikeLineBlockSpan(sql, cursor, activeStatementSpan) ?? activeStatementSpan;
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

const SQL_IDENTIFIER_START_CHAR = /[@_\p{ID_Start}]/u;
const SQL_IDENTIFIER_SUFFIX = /[$@_\u200c\u200d\p{ID_Continue}]+$/u;
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

export function getSqlCompletionContext(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): SqlCompletionContext {
  const statementSpan = sqlCompletionStatementSpan(sql, cursor, options);
  // Extract the full statement at cursor position for referenced tables
  const rawStatement = sql.slice(statementSpan.start, statementSpan.end);
  const fullStatement = rawStatement.trim();
  const cursorInStatement = cursor - statementSpan.start - (rawStatement.length - rawStatement.trimStart().length);

  // Content before cursor within the current statement
  const beforeCursor = sql.slice(statementSpan.start, cursor);

  const trailingIdentifier = parseTrailingIdentifierContext(beforeCursor, options.databaseType);
  const prefix = trailingIdentifier?.prefix ?? "";
  const qualifier = trailingIdentifier?.qualifier;
  const qualifierParts = trailingIdentifier?.qualifierParts;
  const bareStart = trailingIdentifier?.start ?? beforeCursor.length;
  const beforeToken = beforeCursor.slice(0, Math.max(0, bareStart)).trimEnd();
  const lastWord = /([A-Za-z_][\w$]*)$/.exec(beforeToken)?.[1]?.toLowerCase() ?? "";

  // CTE bodies are their own scope: resolve them first so the outer query's
  // referenced tables are read from a statement with those bodies blanked out.
  const cteDefs = scanCteDefinitions(fullStatement);
  let referencedTables = extractReferencedTables(maskResolvedCteBodies(fullStatement, cursorInStatement, cteDefs), options.databaseType);
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
  const oracleTableFunctionContext = detectOracleTableFunctionContext(beforeCursor, options.databaseType);

  // Hoisted out of the three checks below: they previously called isInTableListContext with
  // identical arguments three times, which was cheap when it was regex-based but now runs a full
  // tokenizeSqlSemantic pass, so the duplicate work is worth avoiding.
  const inTableListContext = isInTableListContext(beforeToken, options.databaseType);
  const afterTableTrigger = isTableTriggerKeyword(lastWord, options) || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || inTableListContext;
  const exclusiveTableSuggestions = EXCLUSIVE_TABLE_TRIGGER_KEYWORDS.has(lastWord) || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || inTableListContext;
  const tableAliasAfterCursor = hasTableAliasAfterCursor(sql, cursor);
  const autoAliasTableCompletions = (lastWord === "from" || lastWord === "join" || (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) || inTableListContext) && !tableAliasAfterCursor;
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
  const dataTypeContext = isCreateTableColumnTypeContext(beforeToken, options.databaseType);
  const preferredValueKeywords = sqlServerDatepartCompletionValues(beforeCursor, options.databaseType);
  const preferredKeywords = qualifier ? [] : preferredKeywordsForCompletion(beforeCursor, beforeToken, selectListColumnContext, exclusiveTableSuggestions, updateInfo, deleteInfo, options.databaseType);
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
    preferredValueKeywords,
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
    insertDatabase: insertInfo?.database,
    insertSchema: insertInfo?.schema,
    statementKind,
    tableTriggerWord: lastWord || undefined,
    isGroupBy: isInGroupByContext(beforeCursor),
    isEmptyGroupBy: isEmptyGroupByContext(beforeCursor),
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
    openingParenAfterCursor: /^\s*\(/.test(sql.slice(cursor)),
    contextKind,
    dataTypeContext,
  };
}

function sqlServerDatepartCompletionValues(beforeCursor: string, databaseType?: DatabaseType): string[] | undefined {
  if (databaseType !== "sqlserver") return undefined;
  const call = findActiveFunctionCall(beforeCursor);
  if (!call || call.activeGroup !== 0 || !SQLSERVER_DATEPART_FUNCTIONS.has(call.name.toUpperCase())) return undefined;
  return countTopLevelCommas(call.groupText) === 0 ? SQLSERVER_DATEPART_VALUES : undefined;
}

function isCreateTableColumnTypeContext(beforeToken: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeToken, databaseType);
  if (!/^\s*create\s+table\b/i.test(cleaned)) return false;

  const bodyStart = cleaned.indexOf("(");
  if (bodyStart < 0) return false;

  let depth = 0;
  let segmentStart = bodyStart + 1;
  for (let index = bodyStart + 1; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) segmentStart = index + 1;
  }

  const segment = cleaned.slice(segmentStart).trim();
  return /^(?:[A-Za-z_][\w$]*|`[^`]+`|"[^"]+"|\[[^\]]+\])$/.test(segment);
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

function parseTrailingIdentifierContext(input: string, databaseType?: DatabaseType): { start: number; prefix: string; qualifier?: string; qualifierParts?: string[] } | null {
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
    if (!parsed) {
      const omittedSqlServerSchema = databaseType === "sqlserver" && tail[index - 1] === "." && parseTrailingIdentifierPart(tail, index - 1);
      if (!omittedSqlServerSchema) break;
      parts.unshift(SQLSERVER_DEFAULT_SCHEMA);
      index -= 1;
      continue;
    }
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

  if (tailChar === "]") {
    let start = end - 1;
    while (start >= 0) {
      if (input[start] === "[") return { start, raw: input.slice(start, endExclusive) };
      start -= 1;
    }
    return null;
  }

  const match = SQL_IDENTIFIER_SUFFIX.exec(input.slice(0, endExclusive));
  if (!match) return null;
  const raw = match[0];
  const firstCodePoint = raw.codePointAt(0);
  if (firstCodePoint === undefined || !SQL_IDENTIFIER_START_CHAR.test(String.fromCodePoint(firstCodePoint))) return null;
  return { start: match.index, raw };
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

function isEmptyGroupByContext(beforeCursor: string): boolean {
  if (!isInGroupByContext(beforeCursor)) return false;
  const cleaned = beforeCursor
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .toLowerCase();
  const lastGroupBy = cleaned.lastIndexOf("group by");
  return lastGroupBy >= 0 && cleaned.slice(lastGroupBy + "group by".length).trim().length === 0;
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

function detectInsertColumnListContext(beforeCursor: string): { table: string; database?: string; schema?: string } | null {
  // Keep quoted identifiers intact so schema/table targets resolve to their
  // real names instead of placeholder string contents.
  const cleaned = beforeCursor.replace(/'[^']*'/g, "''");
  const identifier = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  const qualifiedIdentifier = `${identifier}(?:\\.${identifier}){0,2}`;
  const match = new RegExp(`\\binsert\\s+into\\s+(${qualifiedIdentifier})\\s*\\([^)]*$`, "i").exec(cleaned);
  if (!match) return null;
  const fullTable = match[1];
  if (!fullTable) return null;
  const parts = splitQualifiedNameParts(fullTable);
  const table = parts[parts.length - 1];
  if (!table) return null;
  return {
    table,
    database: parts.length >= 3 ? parts[parts.length - 3] : undefined,
    schema: parts.length >= 2 ? parts[parts.length - 2] : undefined,
  };
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

function detectOracleTableFunctionContext(beforeCursor: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeCursor, databaseType);
  return /\b(?:from|join)\s+table\s*\(\s*(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\.){0,2}[A-Za-z_][\w$]*$/i.test(cleaned);
}

function preferredKeywordsForCompletion(
  beforeCursor: string,
  beforeToken: string,
  selectListColumnContext: boolean,
  exclusiveTableSuggestions: boolean,
  updateInfo: ReturnType<typeof detectUpdateCompletionContext>,
  deleteInfo: ReturnType<typeof detectDeleteCompletionContext>,
  databaseType: DatabaseType | undefined,
): string[] {
  const keywords: string[] = [];
  if (selectListColumnContext && hasSelectListExpression(beforeCursor, databaseType)) keywords.push("FROM");
  if (isAfterJoinModifierContext(beforeCursor, databaseType)) keywords.push("JOIN");
  if (!exclusiveTableSuggestions && isAfterSelectBodyExpression(beforeToken, databaseType)) keywords.push("LIMIT");
  if (isAfterConditionExpression(beforeToken, databaseType)) keywords.push("AND", "OR");
  if (updateInfo?.afterTarget) keywords.push("SET");
  if (updateInfo?.afterSetAssignments) keywords.push("WHERE");
  if (deleteInfo?.afterTarget) keywords.push("WHERE");
  return keywords;
}

function hasSelectListExpression(beforeCursor: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeCursor, databaseType).trimEnd();
  const selectIndex = lastTopLevelKeywordIndex(cleaned, "select");
  if (selectIndex < 0) return false;
  const afterSelect = cleaned.slice(selectIndex + "select".length).trim();
  return !!afterSelect && !/^distinct\s*$/i.test(afterSelect);
}

function isAfterSelectBodyExpression(beforeToken: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeToken, databaseType).trimEnd();
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

function isAfterConditionExpression(beforeToken: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeToken, databaseType).trimEnd();
  if (!hasActiveConditionClause(cleaned)) return false;
  const lastKeyword = /\b([A-Za-z_][\w$]*)\s*$/.exec(cleaned)?.[1]?.toLowerCase();
  if (lastKeyword && CONDITION_INCOMPLETE_TAIL_KEYWORDS.has(lastKeyword)) return false;
  return isExpressionTailComplete(cleaned);
}

function isAfterJoinModifierContext(beforeCursor: string, databaseType: DatabaseType | undefined): boolean {
  const cleaned = maskSqlLiteralsAndComments(beforeCursor, databaseType).trimEnd();
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

// Dialects whose unquoted identifiers are ANSI/ASCII-only in practice; matching a Unicode
// unquoted token as a table reference there is a false-positive risk. Everything else defaults
// to Unicode support (MySQL/Postgres/SQL Server/SQLite/DuckDB and the many Chinese-vendor
// engines this product supports legitimately use non-ASCII unquoted identifiers).
const ASCII_ONLY_UNQUOTED_IDENTIFIER_DATABASES = new Set<DatabaseType>(["clickhouse", "snowflake", "bigquery", "hive", "spark", "trino", "prestosql", "impala", "db2", "teradata"]);

// Dialects where a bare "--" needs trailing whitespace/EOL to start a comment, since MySQL
// reserves unspaced "--" for double-negation (e.g. `SELECT 1--1`). Scoped to mysql itself plus
// its wire-protocol-compatible clones confirmed to share this exact parser quirk; other
// MySQL-family members (hive, impala, spark, access, databend, tdengine, kyuubi) are left out
// since their grammars aren't confirmed to share it, and the safe default (unchanged behavior,
// bare "--" always starts a comment) is correct there.
const MYSQL_DASH_COMMENT_DIALECTS = new Set<DatabaseType>(["mysql", "doris", "starrocks"]);

// Dialects that use MySQL-style backslash escaping (`\'`) inside '...' strings by convention.
// Deliberately a *different, wider* set than MYSQL_DASH_COMMENT_DIALECTS above: that one is
// narrowly scoped to a confirmed MySQL-only parser quirk (the "--" double-negation rule), while
// backslash escaping is a much more widely shared trait across MySQL's wire-protocol/grammar
// lineage -- confirmed by a real regression where Hive (not in MYSQL_DASH_COMMENT_DIALECTS) lost
// a table reference because its backslash-escaped string wasn't recognized. Not applied
// unconditionally to every dialect: see readQuotedString's doc comment in semantic/tokens.ts for
// why that's unsafe (a trailing backslash before a closing quote in a dialect that doesn't escape
// it, e.g. a Postgres Windows-path string literal, would misread the real closing quote as
// escaped and swallow the rest of the query).
const BACKSLASH_ESCAPE_STRING_DIALECTS = new Set<DatabaseType>(["mysql", "doris", "starrocks", "hive", "impala", "spark"]);

// Table/schema/db unquoted-identifier continue class needs @ and # in addition to what
// SQL_IDENTIFIER_CONTINUE_CHAR covers, so splice its inner class body into a locally-built class
// instead of retyping the same Unicode escapes by hand.
const TABLE_REF_UNQUOTED_CONTINUE_SOURCE = `[@#${SQL_IDENTIFIER_CONTINUE_CHAR.source.slice(1, -1)}]`;
// The start class intentionally excludes '@' (unlike SQL_IDENTIFIER_START_CHAR, which includes
// it for a different purpose at its own call sites), so it's kept as its own small literal.
const TABLE_REF_UNQUOTED_START_SOURCE = "[_\\p{ID_Start}]";
const TABLE_REF_UNQUOTED_IDENTIFIER_UNICODE = `${TABLE_REF_UNQUOTED_START_SOURCE}${TABLE_REF_UNQUOTED_CONTINUE_SOURCE}*`;
const TABLE_REF_UNQUOTED_IDENTIFIER_ASCII = "[A-Za-z_][\\w$@#]*";
// Alias-group continue class is character-for-character identical to SQL_IDENTIFIER_CONTINUE_CHAR.
const TABLE_REF_ALIAS_UNICODE = `${TABLE_REF_UNQUOTED_START_SOURCE}${SQL_IDENTIFIER_CONTINUE_CHAR.source}*`;
const TABLE_REF_ALIAS_ASCII = "[A-Za-z_][\\w$]*";

const TABLE_REF_QUOTED_IDENTIFIER = `(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\])`;

// Keywords that introduce a table reference, deduplicated into one array so buildTableRefPattern's
// regex has a single source of truth instead of an inline copy.
const TABLE_REF_INTRODUCER_KEYWORDS = ["from", "join", "straight_join", "update", "apply"];

function buildTableRefPattern(unquotedIdentifier: string, aliasIdentifier: string, allowSqlServerDoubleDot: boolean): RegExp {
  const identifier = `(?:${TABLE_REF_QUOTED_IDENTIFIER}|${unquotedIdentifier})`;
  const qualifiedSeparator = allowSqlServerDoubleDot ? `\\.(?:${identifier}|\\.${identifier})` : `\\.${identifier}`;
  return new RegExp(`\\b(?:${TABLE_REF_INTRODUCER_KEYWORDS.join("|")})\\s+(${identifier}(?:${qualifiedSeparator}){0,3})(?:\\s+(?:as\\s+)?(${aliasIdentifier}))?`, "giu");
}

// Precompiled once at module load (not per extractReferencedTables call) since this runs on
// effectively every keystroke through the SQL editor's completion pipeline.
const TABLE_REF_PATTERN_ASCII = buildTableRefPattern(TABLE_REF_UNQUOTED_IDENTIFIER_ASCII, TABLE_REF_ALIAS_ASCII, false);
const TABLE_REF_PATTERN_UNICODE_DEFAULT = buildTableRefPattern(TABLE_REF_UNQUOTED_IDENTIFIER_UNICODE, TABLE_REF_ALIAS_UNICODE, false);
const TABLE_REF_PATTERN_UNICODE_SQLSERVER = buildTableRefPattern(TABLE_REF_UNQUOTED_IDENTIFIER_UNICODE, TABLE_REF_ALIAS_UNICODE, true);

/**
 * Masks string literals and comments so keyword/table-reference scanning never mistakes text
 * inside them for real SQL (e.g. `'from 测试表'` or `-- from 测试表`). Built on
 * tokenizeSqlSemantic's own dialect-aware scan (the same one used for statement-span/lexical-
 * context detection elsewhere in this file) rather than a hand-rolled lexer, so backtick- and
 * bracket-quoted identifier spans are skipped correctly for free.
 *
 * `"..."` is dialect-ambiguous: Postgres/SQL Server/generic always treat it as identifier
 * quoting, while MySQL's own dialect adapter (see semantic/dialect.ts) also lists '"' as a valid
 * identifierQuotes entry -- but only because MySQL *can* be run with the ANSI_QUOTES sql_mode.
 * Under MySQL's actual default sql_mode (ANSI_QUOTES disabled) it's a plain string literal instead,
 * with the exact same rules as `'...'`, everywhere in a statement: inside function arguments
 * (`CONCAT("from ghost_table", name)`), CASE branches (`WHEN x THEN "from ghost_case"`), nested
 * expressions, anywhere. There's no way for this code to observe the connected server's *actual*
 * runtime sql_mode, so rather than guessing a dialect-wide default (and being wrong for whichever
 * sql_mode isn't guessed), this resolves the ambiguity by *position* instead, for dialects in
 * MYSQL_DASH_COMMENT_DIALECTS (MySQL itself plus confirmed sql_mode-parity wire-protocol clones --
 * the same scope already used above for MySQL's other sql_mode-governed lexical quirks): a `"..."`
 * span immediately in table-reference position -- right after one of
 * TABLE_REF_INTRODUCER_KEYWORDS (`from`/`join`/`straight_join`/`update`/`apply`, exactly what
 * extractReferencedTables's own regex looks for below), or a `.`-qualified continuation of one
 * (`"db"."orders"`) -- is left unmasked as a potential identifier, matching ANSI_QUOTES-enabled
 * MySQL. Every other `"..."` position (function args, CASE branches, operator-adjacent values, and
 * everywhere else) is masked as a value, matching MySQL's actual default sql_mode. This is correct
 * under *both* sql_modes at once: a real ANSI_QUOTES table name in `FROM "orders"` still resolves,
 * while the ghost-table false positives this function exists to fix (`CONCAT("from ghost_table",
 * ...)`, `CASE ... THEN "from ghost_case"`) stay masked regardless of the connected sql_mode.
 *
 * For every other dialect, where `"..."` unconditionally means identifier (Postgres, SQL Server's
 * ANSI mode, generic), a `"..."` span right after an operator token (`=`, `<`, `<>`, `!=`, ...) is
 * still masked as if it were a value: that position is unambiguous regardless of dialect (`col =
 * "literal"` is never a quoted identifier there), so leaving it unmasked would misdetect e.g.
 * Postgres's `WHERE note = "from ghost"` as a table reference. Every other position (right after
 * FROM/JOIN, a `.` qualifier, a function's `(`, etc.) is left unmasked as a potential identifier for
 * these dialects, same as before.
 *
 * The masked replacement doesn't need to preserve length or map back to offsets in `sql` --
 * callers only read captured regex groups (or do their own keyword search) off the masked copy.
 * It DOES need to preserve a non-whitespace trailing marker for string/value tokens though: most
 * callers of this helper trim trailing whitespace and then look at the last character to decide
 * whether an expression is "complete" (e.g. `isAfterConditionExpression`'s
 * `isExpressionTailComplete`). Collapsing a trailing value to a single space would get eaten by
 * that trim, exposing whatever came before it (e.g. the `=` in `WHERE x = "value"`) as if it were
 * the real tail, wrongly reporting an in-progress/incomplete expression -- confirmed to wrongly
 * suppress the AND/OR keyword suggestion after a perfectly complete condition. So string/masked
 * value tokens are replaced with their own quote character doubled (`''` / `""`), mirroring the
 * pre-existing convention this helper's predecessor (the regex-based `stripSqlLiterals`) already
 * used for exactly this reason. Comments don't represent a value and are still collapsed to a
 * single space -- getting trimmed away and exposing the real preceding tail is the correct
 * behavior there (already covered by existing tests).
 */
function maskSqlLiteralsAndComments(sql: string, databaseType?: DatabaseType): string {
  const dialectId = resolveSqlDialectId({ databaseType });
  const mysqlFamily = !!databaseType && MYSQL_DASH_COMMENT_DIALECTS.has(databaseType);
  const mysqlBackslashEscape = !!databaseType && BACKSLASH_ESCAPE_STRING_DIALECTS.has(databaseType);
  // "..." always tokenizes as quoted_identifier here (never forced to "string") -- MySQL-family
  // string-vs-identifier ambiguity is resolved below by token position instead, so the underlying
  // scan doesn't need to guess a dialect-wide default. See this function's doc comment above.
  const tokens = tokenizeSqlSemantic(sql, dialectId, { mysqlDashCommentRequiresWhitespace: mysqlFamily, mysqlBackslashEscape });

  let out = "";
  let cursor = 0;
  // Tracks "the previous non-comment token was an operator" for the unconditional-identifier
  // dialects' operator-adjacency fallback below -- a comment sitting between an operator and its
  // value (e.g. `= /* x */ "from ghost"`) must not reset this, or the value right after the
  // comment escapes masking.
  let afterValueOperator = false;
  // Tracks whether the *next* token sits in table-reference position (right after
  // TABLE_REF_INTRODUCER_KEYWORDS, or a `.`-qualified continuation of one) for the MySQL-family
  // position-based rule below. Survives comment tokens the same way afterValueOperator does --
  // `FROM /* c */ "orders"` must still resolve "orders" as a table.
  let tableRefState: "none" | "expectSegment" | "afterSegment" = "none";
  for (const t of tokens) {
    out += sql.slice(cursor, t.span.start);
    const isDoubleQuotedIdentifier = t.kind === "quoted_identifier" && t.quote === '"';
    const isTableRefSegment = tableRefState === "expectSegment" && (t.kind === "quoted_identifier" || t.kind === "word");
    const maskAsValue = t.kind === "string" || (isDoubleQuotedIdentifier && (afterValueOperator || (mysqlFamily && !isTableRefSegment)));
    if (t.kind === "comment") {
      out += " ";
    } else if (maskAsValue) {
      out += (t.quote ?? '"').repeat(2);
    } else {
      out += sql.slice(t.span.start, t.span.end);
    }
    cursor = t.span.end;
    afterValueOperator = t.kind === "operator" || (t.kind === "comment" && afterValueOperator);
    if (t.kind !== "comment") {
      tableRefState =
        tableRefState === "expectSegment" && (t.kind === "quoted_identifier" || t.kind === "word")
          ? "afterSegment"
          : tableRefState === "afterSegment" && t.kind === "punctuation" && t.text === "."
            ? "expectSegment"
            : t.kind === "word" && TABLE_REF_INTRODUCER_KEYWORDS.includes(t.normalized)
              ? "expectSegment"
              : "none";
    }
  }
  out += sql.slice(cursor);
  return out;
}

function extractReferencedTables(sql: string, databaseType?: DatabaseType): SqlCompletionReferencedTable[] {
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
  // Unquoted identifiers may contain non-ASCII letters (e.g. Chinese/Japanese/Korean database,
  // schema and table names are valid unquoted MySQL/Postgres/etc. identifiers) for dialects that
  // actually support it — ANSI-strict dialects (ClickHouse, Snowflake, BigQuery, Hive/Spark/
  // Trino/Presto/Impala, Db2, Teradata) keep the ASCII-only shape to avoid false-positive matches.
  // An unresolved databaseType (e.g. a scratch editor before a connection is picked) also defaults
  // to ASCII-only, matching this function's behavior before dialect-aware Unicode matching existed.
  const pattern = !databaseType || ASCII_ONLY_UNQUOTED_IDENTIFIER_DATABASES.has(databaseType) ? TABLE_REF_PATTERN_ASCII : databaseType === "sqlserver" ? TABLE_REF_PATTERN_UNICODE_SQLSERVER : TABLE_REF_PATTERN_UNICODE_DEFAULT;
  // These are shared module-level RegExp objects (built once for performance), so reset
  // lastIndex before each scan rather than relying on a fresh object per call.
  pattern.lastIndex = 0;
  // Scan a masked copy so string literals and comments can never be mistaken for a real
  // FROM/JOIN table reference; double-quoted table names survive masking (see
  // maskSqlLiteralsAndComments), so the returned table info built from `match` is unaffected.
  const scanSql = maskSqlLiteralsAndComments(sql, databaseType);
  const referenced: SqlCompletionReferencedTable[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scanSql)) !== null) {
    const rawName = match[1];
    const alias = match[2];
    if (alias && ALIAS_BLACKLIST.has(alias.toLowerCase())) {
      pattern.lastIndex = match.index + match[0].length - alias.length;
    }
    const quotedName = !!rawName && (rawName.startsWith('"') || rawName.startsWith("`") || rawName.startsWith("["));
    if (!quotedName && rawName && ALIAS_BLACKLIST.has(rawName.toLowerCase())) continue;
    // Filter out SQL keywords that accidentally matched as aliases
    const cleanAlias = alias && !ALIAS_BLACKLIST.has(alias.toLowerCase()) ? alias : undefined;
    if (isElasticsearchStyleIndexName(rawName)) {
      referenced.push({ name: unquoteIdentifier(rawName), alias: cleanAlias });
      continue;
    }
    const rawParts = splitQualifiedNameRawParts(rawName);
    const omittedSqlServerSchema = databaseType === "sqlserver" && rawParts.length >= 3 && rawParts[rawParts.length - 2] === "";
    const unquotedRawParts = rawParts.map((part) => unquoteIdentifier(part));
    const parts = rawParts.map((part) => unquoteIdentifier(part)).filter(Boolean);
    const name = unquotedRawParts[unquotedRawParts.length - 1];
    if (!name) continue;
    const table: SqlCompletionReferencedTable = {
      name,
      nameQuoted: isQuotedIdentifier(rawParts[rawParts.length - 1]),
      database: omittedSqlServerSchema ? unquotedRawParts[unquotedRawParts.length - 3] || undefined : parts.length >= 3 ? parts[parts.length - 3] : undefined,
      schema: omittedSqlServerSchema ? SQLSERVER_DEFAULT_SCHEMA : parts.length >= 2 ? parts[parts.length - 2] : undefined,
      schemaQuoted: omittedSqlServerSchema ? undefined : parts.length >= 2 ? isQuotedIdentifier(rawParts[rawParts.length - 2]) : undefined,
      alias: cleanAlias,
    };
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

interface ScannedCteDefinition {
  name: string;
  columns: string[];
  /** Index of the `(` opening the CTE body. */
  bodyStart: number;
  /** Index of the `)` closing the CTE body. */
  bodyEnd: number;
}

/**
 * Scans `WITH` definitions, keeping each body's span so callers can tell which
 * part of the statement belongs to a CTE rather than to the outer query.
 */
function scanCteDefinitions(sql: string): ScannedCteDefinition[] {
  const ctes: ScannedCteDefinition[] = [];
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

    ctes.push({ name: cteName, columns, bodyStart: pos, bodyEnd });
    pos = bodyEnd + 1;
  }

  return ctes;
}

export function extractCteDefinitions(sql: string): Array<{ name: string; columns: string[] }> {
  return scanCteDefinitions(sql).map(({ name, columns }) => ({ name, columns }));
}

/**
 * Blanks out CTE bodies whose projected columns are already known, so the outer
 * query's referenced tables stay scoped to its own row sources. Without this the
 * tables read inside a CTE (`WITH cte AS (SELECT id, name FROM t) SELECT na|`)
 * would count as extra outer row sources and force every column suggestion to be
 * qualified, hiding the bare `name` candidate the CTE actually provides.
 *
 * The body holding the cursor is never blanked -- completion inside a CTE body
 * still needs that body's own tables -- and neither is a body whose columns could
 * not be resolved (e.g. `SELECT *`), where the underlying table remains the only
 * source of column names.
 */
function maskResolvedCteBodies(statement: string, cursorOffset: number, ctes: readonly ScannedCteDefinition[]): string {
  let masked = statement;
  for (const cte of ctes) {
    if (cte.columns.length === 0) continue;
    if (cursorOffset > cte.bodyStart && cursorOffset <= cte.bodyEnd) continue;
    const bodyLength = cte.bodyEnd - cte.bodyStart - 1;
    if (bodyLength <= 0) continue;
    masked = `${masked.slice(0, cte.bodyStart + 1)}${" ".repeat(bodyLength)}${masked.slice(cte.bodyEnd)}`;
  }
  return masked;
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
  const unquoted = splitQualifiedNameParts(input);
  if (unquoted.length >= 2) return [unquoted[unquoted.length - 2], unquoted[unquoted.length - 1]];
  return [unquoted[0], undefined];
}

function splitQualifiedNameParts(input: string): string[] {
  return splitQualifiedNameRawParts(input)
    .map((part) => unquoteIdentifier(part))
    .filter(Boolean);
}

function splitQualifiedNameRawParts(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inBacktick && !inBracket) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (ch === "`" && !inDoubleQuote && !inBracket) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    if (ch === "[" && !inDoubleQuote && !inBacktick) inBracket = true;
    if (ch === "]" && inBracket) inBracket = false;
    if (ch === "." && !inDoubleQuote && !inBacktick && !inBracket) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}

function isQuotedIdentifier(value: string | undefined): boolean {
  if (!value) return false;
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("`") && value.endsWith("`")) || (value.startsWith("[") && value.endsWith("]"));
}

function unquoteIdentifier(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("`") && value.endsWith("`")) || (value.startsWith("[") && value.endsWith("]"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function quoteSqlIdentifier(identifier: string, dialect?: SqlCompletionApplyDialect): string {
  if (dialect === "oracle") {
    if (/^[A-Za-z][A-Za-z0-9_$#]*$/.test(identifier) && !POSTGRES_IDENTIFIER_KEYWORDS.has(identifier.toLowerCase())) return identifier;
    return `"${identifier.replaceAll('"', '""')}"`;
  }
  if (dialect === "upper") {
    if (/^[A-Z][A-Z0-9_$#]*$/.test(identifier) && !POSTGRES_IDENTIFIER_KEYWORDS.has(identifier.toLowerCase())) return identifier;
    return `"${identifier.replaceAll('"', '""')}"`;
  }
  if (dialect !== "postgres" || !requiresPostgresIdentifierQuote(identifier, POSTGRES_IDENTIFIER_KEYWORDS)) return identifier;
  return `"${identifier.replaceAll('"', '""')}"`;
}

const POSTGRES_IDENTIFIER_KEYWORDS = new Set(SQL_KEYWORDS.map((keyword) => keyword.toLowerCase()));

// Unlike quoteSqlIdentifier (also used by the data grid condition editor, which
// intentionally leaves MySQL identifiers unquoted and applies backticks itself
// at insertion time), SQL editor completion apply/insertText needs the quoting
// baked in up front, so MySQL reserved-word identifiers get backtick-quoted here.
function quoteCompletionApplyIdentifier(identifier: string, dialect?: SqlCompletionApplyDialect): string {
  if (dialect === "mysql") {
    if (!requiresMysqlIdentifierQuote(identifier, POSTGRES_IDENTIFIER_KEYWORDS)) return identifier;
    return `\`${identifier.replaceAll("`", "``")}\``;
  }
  return quoteSqlIdentifier(identifier, dialect);
}

function quoteCompletionApplyName(applyName: string, dialect?: SqlCompletionApplyDialect): string {
  if (dialect !== "mysql" && dialect !== "oracle") return applyName;
  const parts = splitQualifiedNameRawParts(applyName);
  if (parts.length === 0) return applyName;
  return parts.map((part) => (isQuotedIdentifier(part) ? part : quoteCompletionApplyIdentifier(part, dialect))).join(".");
}

function quoteCompletionRoutineIdentifier(identifier: string, dialect?: SqlCompletionApplyDialect): string {
  if (dialect === "oracle" && /^[A-Za-z][A-Za-z0-9_$#]*$/.test(identifier) && !POSTGRES_IDENTIFIER_KEYWORDS.has(identifier.toLowerCase())) return identifier;
  return quoteCompletionApplyIdentifier(identifier, dialect);
}

function quoteCompletionRoutineName(applyName: string, dialect?: SqlCompletionApplyDialect): string {
  if (dialect !== "oracle") return quoteCompletionApplyName(applyName, dialect);
  const parts = splitQualifiedNameRawParts(applyName);
  if (parts.length === 0) return applyName;
  return parts.map((part) => (isQuotedIdentifier(part) ? part : quoteCompletionRoutineIdentifier(part, dialect))).join(".");
}

function quoteSelectStarColumnIdentifier(identifier: string, dialect?: SqlCompletionApplyDialect, databaseType?: DatabaseType): string {
  if (!requiresPostgresIdentifierQuote(identifier, POSTGRES_IDENTIFIER_KEYWORDS)) return identifier;
  if (databaseType) return quoteTableIdentifier(databaseType, identifier);
  if (dialect === "mysql") return `\`${identifier.replaceAll("`", "``")}\``;
  if (dialect === "sqlserver") return `[${identifier.replaceAll("]", "]]")}]`;
  return quoteSqlIdentifier(identifier, dialect);
}

/**
 * Build a normalized table-name -> set-of-schemas index used to detect when a
 * bare table name is ambiguous across schemas. Shared by buildTableItems and
 * buildForeignKeyRelatedTableItems so both apply the same ambiguity signal.
 */
function collectSchemasByTableName(tables: SqlCompletionTable[]): Map<string, Set<string>> {
  const schemasByTableName = new Map<string, Set<string>>();
  for (const table of tables) {
    const tableName = normalizeIdentifierPart(table.name);
    const schemas = schemasByTableName.get(tableName) ?? new Set<string>();
    schemas.add(normalizeIdentifierPart(table.schema ?? ""));
    schemasByTableName.set(tableName, schemas);
  }
  return schemasByTableName;
}

/**
 * Resolve the schema-qualification signals for a completion table.
 *
 * Shared by buildTableItems and buildForeignKeyRelatedTableItems so foreign-key
 * related candidates stay consistent with regular table candidates: when the
 * same table name exists in multiple schemas, both qualify the apply text with
 * `schema.table`. Otherwise an FK candidate would insert a bare `customers AS cs`
 * that may reference the wrong schema and carry a different dedupeKey than the
 * regular candidate, producing a duplicate. Oracle keeps its current-schema
 * behavior; the generic/PostgreSQL/SQL Server paths qualify on ambiguity.
 */
function resolveTableSchemaQualification(
  table: SqlCompletionTable,
  dialect: SqlCompletionApplyDialect | undefined,
  databaseType: DatabaseType | undefined,
  currentSchema: string | undefined,
  schemasByTableName: Map<string, Set<string>>,
): { ambiguousTableName: boolean; schemaQualification: boolean; defaultApplyName: string } {
  const oracleSchemaQualification = databaseType === "oracle" && table.schema && table.schema.toUpperCase() !== "PUBLIC" && (!currentSchema || normalizeIdentifierPart(table.schema) !== normalizeIdentifierPart(currentSchema));
  // A bare table name is ambiguous when metadata contains the same name in multiple schemas.
  // Keep Oracle's current-schema behavior, but qualify the generic/PostgreSQL/SQL Server paths.
  const ambiguousTableName = databaseType !== "oracle" && (schemasByTableName.get(normalizeIdentifierPart(table.name))?.size ?? 0) > 1;
  const schemaQualification = !!table.schema && (oracleSchemaQualification || ambiguousTableName);
  const defaultApplyName = schemaQualification ? `${quoteCompletionApplyIdentifier(table.schema!, dialect)}.${quoteCompletionApplyIdentifier(table.name, dialect)}` : quoteCompletionApplyIdentifier(table.name, dialect);
  return { ambiguousTableName, schemaQualification, defaultApplyName };
}

function buildTableItems(
  context: Pick<SqlCompletionContext, "prefix" | "qualifier">,
  tables: SqlCompletionTable[],
  dialect?: SqlCompletionApplyDialect,
  autoAliasTables = false,
  referencedTables: SqlCompletionReferencedTable[] = [],
  databaseType?: DatabaseType,
  currentSchema?: string,
  keywordCase?: SqlKeywordCase,
): SqlCompletionItem[] {
  const { prefix } = context;
  const qualifierSchema = context.qualifier?.split(".").filter(Boolean).pop();
  const existingAliases = new Set(referencedTables.map((ref) => ref.alias?.toLowerCase()).filter((alias): alias is string => !!alias));
  const matchingTables = tables.filter((table) => matchesPrefix(table.name, prefix));
  // Ambiguity is decided among prefix-matching tables only, matching prior behavior.
  const schemasByTableName = collectSchemasByTableName(matchingTables);
  return matchingTables
    .map((table) => {
      const qualifiedByContext = !!qualifierSchema && !!table.schema && normalizeIdentifierPart(qualifierSchema) === normalizeIdentifierPart(table.schema);
      const { ambiguousTableName, defaultApplyName } = resolveTableSchemaQualification(table, dialect, databaseType, currentSchema, schemasByTableName);
      const suppliedApplyName = table.applyName?.trim();
      const suppliedApplyNameIsQualified = suppliedApplyName?.includes(".") === true;
      const applyName = qualifiedByContext ? quoteCompletionApplyIdentifier(table.name, dialect) : ambiguousTableName && !!table.schema && (!suppliedApplyName || !suppliedApplyNameIsQualified) ? defaultApplyName : (suppliedApplyName ?? defaultApplyName);
      const alias = autoAliasTables ? generateTableCompletionAlias(table.name, existingAliases) : "";
      const schemaDetail = ambiguousTableName && table.schema ? `${table.schema}.${table.name}` : undefined;
      const detail = table.detail && schemaDetail ? `${schemaDetail}  ${table.detail}` : (table.detail ?? schemaDetail ?? (table.type === "table" ? undefined : table.type));
      return {
        label: table.name,
        type: "table" as const,
        detail,
        apply: formatTableAliasApply(applyName, alias, databaseType, keywordCase),
        boost: computeBoost(table.name, prefix) + 1000 + (table.boost ?? 0),
        dedupeKey: table.applyName || ambiguousTableName || (databaseType === "oracle" && table.schema) ? applyName : undefined,
      };
    })
    .sort(compareCompletionItems)
    .slice(0, MAX_TABLE_COMPLETION_ITEMS);
}

function buildForeignKeyRelatedTableItems(
  context: SqlCompletionContext,
  tables: SqlCompletionTable[],
  foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>,
  dialect?: SqlCompletionApplyDialect,
  autoAliasTables = false,
  databaseType?: DatabaseType,
  keywordCase?: SqlKeywordCase,
  currentSchema?: string,
): SqlCompletionItem[] {
  if (!foreignKeysByTable || context.referencedTables.length === 0) return [];
  const candidates = new Map<string, { table: SqlCompletionTable; detail: string }>();
  const existingAliases = new Set(context.referencedTables.map((ref) => ref.alias?.toLowerCase()).filter((alias): alias is string => !!alias));
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

  // Reuse buildTableItems' ambiguity signal so FK candidates qualify with
  // `schema.table` exactly when regular candidates would. Built from the same
  // prefix-matching table set buildTableItems uses, keeping the two in lockstep.
  const schemasByTableName = collectSchemasByTableName(tables.filter((table) => matchesPrefix(table.name, context.prefix)));

  return [...candidates.values()]
    .map(({ table, detail }) => {
      const { ambiguousTableName, defaultApplyName } = resolveTableSchemaQualification(table, dialect, databaseType, currentSchema, schemasByTableName);
      const applyName = defaultApplyName;
      const alias = autoAliasTables ? generateTableCompletionAlias(table.name, existingAliases) : "";
      return {
        label: table.name,
        type: "table" as const,
        detail,
        apply: formatTableAliasApply(applyName, alias, databaseType, keywordCase),
        boost: computeBoost(table.name, context.prefix) + 3600,
        // Mirror buildTableItems' dedupeKey so an FK candidate and the regular
        // candidate for the same schema-qualified table collapse to one entry.
        dedupeKey: ambiguousTableName || (databaseType === "oracle" && table.schema) ? applyName : undefined,
      };
    })
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

function buildSchemaItems(prefix: string, schemas: string[], dialect?: SqlCompletionApplyDialect): SqlCompletionItem[] {
  return schemas
    .filter((schema) => matchesPrefix(schema, prefix))
    .slice(0, 50)
    .map((schema) => ({
      label: schema,
      type: "schema" as const,
      detail: "schema",
      apply: `${quoteCompletionApplyIdentifier(schema, dialect)}.`,
      boost: computeBoost(schema, prefix) + 700,
    }));
}

function buildObjectItems(context: SqlCompletionContext, objects: SqlCompletionObject[], dialect?: SqlCompletionApplyDialect, databaseType?: DatabaseType, currentSchema?: string): SqlCompletionItem[] {
  if (completionQualifierIsReferencedTable(context)) return [];
  const onlyProcedures = context.contextKind === "exec";
  const onlyFunctions = context.suggestColumns && context.referencedTables.length > 0 && !context.qualifier;
  const prioritizeOracleFunctions = databaseType === "oracle" && context.statementKind === "select";
  return objects
    .filter((object) => object.type !== "sequence" && (!onlyProcedures || object.type === "procedure") && (!onlyFunctions || (object.type === "function" && object.name.toLowerCase().startsWith(context.prefix.toLowerCase()))) && objectMatchesCompletionContext(object, context))
    .map((object) => {
      const qualifiedByContext = objectIsQualifiedByContext(object, context);
      const objectInCurrentSchema = !!currentSchema && !!object.schema && normalizeIdentifierPart(object.schema) === normalizeIdentifierPart(currentSchema);
      const suppliedApplyName = object.applyName ? quoteCompletionRoutineName(object.applyName, dialect) : undefined;
      const applyName =
        qualifiedByContext || (context.qualifier && object.schema?.toLowerCase() === context.qualifier.toLowerCase())
          ? quoteCompletionRoutineIdentifier(object.name, dialect)
          : (suppliedApplyName ?? (object.schema && !objectInCurrentSchema ? `${quoteCompletionRoutineIdentifier(object.schema, dialect)}.${quoteCompletionRoutineIdentifier(object.name, dialect)}` : quoteCompletionRoutineIdentifier(object.name, dialect)));
      const locationDetail = object.type === "trigger" && object.parentName ? `trigger on ${object.parentName}` : object.parentName ? `${object.type} in ${object.parentName}` : object.schema ? `${object.type} in ${object.schema}` : object.type;
      const signature = object.signature?.trim();
      const detail = [locationDetail, signature ? `(${signature})` : undefined, object.dataType ? `[${object.dataType}]` : undefined].filter(Boolean).join("  ");
      const schemaBoost = onlyFunctions ? Math.min(object.boost ?? 0, 1000) : (object.boost ?? 0);
      const typeBoost = routineTypeBoost(object.type, prioritizeOracleFunctions && !onlyFunctions);
      const baseDedupeKey = object.applyName || (databaseType === "oracle" && object.schema) ? applyName : undefined;
      return {
        label: object.name,
        type: "function" as const,
        detail,
        info: buildRoutineInfo(object),
        apply: object.type === "trigger" || object.type === "package" ? applyName : buildRoutineApply(applyName, object.signature),
        boost: computeBoost(object.name, context.prefix) + typeBoost + schemaBoost,
        dedupeKey: signature ? `${baseDedupeKey ?? object.name}(${signature})` : baseDedupeKey,
        // Preserve exact routine matches before the capped candidate list is truncated.
        exactMatch: !!context.prefix && object.name.toLowerCase() === context.prefix.toLowerCase(),
      };
    })
    .sort(compareCompletionItems)
    .slice(0, MAX_TABLE_COMPLETION_ITEMS);
}

function buildRoutineApply(applyName: string, signature?: string): string {
  const parameters = splitRoutineSignatureParameters(signature?.trim() ?? "");
  if (parameters.length === 0) return `${applyName}()`;
  return `${applyName}(${parameters.map((parameter, index) => `\${${index + 1}:${escapeSnippetFieldName(parameter)}}`).join(", ")})`;
}

function splitRoutineSignatureParameters(signature: string): string[] {
  if (!signature) return [];
  const parameters: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let quoted = false;

  for (let index = 0; index < signature.length; index++) {
    const char = signature[index];
    if (char === '"') {
      if (quoted && signature[index + 1] === '"') {
        index++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) continue;
    if (char === "(") parenthesisDepth++;
    else if (char === ")" && parenthesisDepth > 0) parenthesisDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]" && bracketDepth > 0) bracketDepth--;
    else if (char === "," && parenthesisDepth === 0 && bracketDepth === 0) {
      const parameter = signature.slice(start, index).trim();
      if (parameter) parameters.push(parameter);
      start = index + 1;
    }
  }

  const parameter = signature.slice(start).trim();
  if (parameter) parameters.push(parameter);
  return parameters;
}

function escapeSnippetFieldName(value: string): string {
  return value.replace(/[{}]/g, "\\$&");
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

function buildOracleTableFunctionItems(prefix: string, keywordCase?: SqlKeywordCase, functionCase?: SqlKeywordCase): SqlCompletionItem[] {
  const items = [
    { label: applySqlKeywordCase("TABLE", keywordCase), detail: "Oracle table function", apply: `${applySqlKeywordCase("TABLE", keywordCase)}(\${function_call})` },
    { label: applySqlKeywordCase("THE", keywordCase), detail: "Oracle nested-table expression", apply: `${applySqlKeywordCase("THE", keywordCase)}(\${subquery})` },
    { label: applySqlFunctionCase("XMLTABLE", functionCase), detail: "XML to relational rows", apply: `${applySqlFunctionCase("XMLTABLE", functionCase)}(\${xpath})` },
    { label: applySqlFunctionCase("JSON_TABLE", functionCase), detail: "JSON to relational rows", apply: `${applySqlFunctionCase("JSON_TABLE", functionCase)}(\${expr}, \${path})` },
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

function applySqlFunctionCase(value: string, functionCase?: SqlKeywordCase): string {
  if (functionCase === "lower") return value.toLowerCase();
  if (functionCase === "upper") return value.toUpperCase();
  return value;
}

const GENERATED_SQL_TEMPLATE_KEYWORDS_RE = /\b(?:AS|INTERVAL|OVER|PARTITION|BY|ORDER)\b/g;

/**
 * Applies the keyword preference to syntax embedded in built-in completion
 * templates while keeping snippet placeholders intact.
 */
function applyGeneratedSqlTemplateKeywordCase(value: string, keywordCase?: SqlKeywordCase): string {
  return value
    .split(/(\$\{[^}]*\})/g)
    .map((part) => (part.startsWith("${") ? part : part.replace(GENERATED_SQL_TEMPLATE_KEYWORDS_RE, (keyword) => applySqlKeywordCase(keyword, keywordCase))))
    .join("");
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

function applyBuiltinSnippetPlaceholders(snippet: SqlSnippet, body = snippet.body): string {
  if (!shouldFormatBuiltinSnippet(snippet)) return body;
  return body.replace(BUILTIN_SNIPPET_PLACEHOLDER_RE, (match) => `\${${match}}`);
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

function selectStarExpansionColumns(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>): SqlCompletionColumn[] {
  const references = referencedTablesForSelectAllColumns(context);
  if (context.qualifier || references.length > 1) {
    return references.flatMap((reference) => uniqueColumnsByName(columnsForSelectAllReferencedTable(reference, columnsByTable)));
  }
  return uniqueColumnsByName([...columnsByTable.values()].flat());
}

export function selectStarResultColumnsMatch(options: { currentSql: string; targetFrom: number; targetTo: number; statementSql: string; sourceStatement?: string; sourceFrom?: number; sourceTo?: number }): boolean {
  if (!options.sourceStatement) return false;
  const hasSourceFrom = typeof options.sourceFrom === "number";
  const hasSourceTo = typeof options.sourceTo === "number";
  if (hasSourceFrom !== hasSourceTo) return false;
  if (!hasSourceFrom || !hasSourceTo) return options.statementSql === options.sourceStatement;
  // 词边界检查：已执行语句可能是当前内容的真前缀（如 `FROM users` → `FROM users_backup`），
  // 此时 slice 仍与 sourceStatement 相等，会用旧表列回退到新表。要求 sourceTo 落在标识符边界。
  const sourceToAtBoundary = !/[\w$]/.test(options.currentSql[options.sourceTo!] ?? "");
  return options.targetFrom >= options.sourceFrom! && options.targetTo <= options.sourceTo! && sourceToAtBoundary && options.currentSql.slice(options.sourceFrom, options.sourceTo) === options.sourceStatement;
}

export function buildSelectStarExpansion(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: SqlCompletionApplyDialect, qualifierSql = context.qualifier, databaseType?: DatabaseType): string | null {
  const columns = selectStarExpansionColumns(context, columnsByTable);
  if (columns.length === 0) return null;
  // `alias.*` replaces only the `*`, so the first column must continue the already typed `alias.`.
  if (qualifierSql) return buildSelectAllColumnExpansion(columns, qualifierSql, true, dialect, databaseType);

  const references = referencedTablesForSelectAllColumns(context);
  if (references.length <= 1) return columns.map((column) => quoteSelectStarColumnIdentifier(column.name, dialect, databaseType)).join(", ");

  return references
    .flatMap((reference) => {
      const qualifier = reference.aliasSql ?? (reference.alias ? quoteCompletionApplyIdentifier(reference.alias, dialect) : quoteCompletionApplyIdentifier(reference.name, dialect));
      return uniqueColumnsByName(columnsForSelectAllReferencedTable(reference, columnsByTable)).map((column) => `${qualifier}.${quoteSelectStarColumnIdentifier(column.name, dialect, databaseType)}`);
    })
    .join(", ");
}

function buildStarExpansionItem(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: SqlCompletionApplyDialect, databaseType?: DatabaseType): SqlCompletionItem | null {
  const expansion = buildSelectStarExpansion(context, columnsByTable, dialect, context.qualifier, databaseType);
  if (!expansion) return null;
  const columnCount = selectStarExpansionColumns(context, columnsByTable).length;
  return {
    label: "* → columns",
    type: "snippet" as const,
    detail: `${(t?.starExpansionColumns ?? "{count} columns").replace("{count}", String(columnCount))}: ${expansion.length > 60 ? expansion.slice(0, 57) + "..." : expansion}`,
    apply: expansion,
    boost: 1900,
  };
}

function buildSelectAllColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: SqlCompletionApplyDialect, databaseType?: DatabaseType): SqlCompletionItem[] {
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

    const qualifier = context.qualifier || ref.alias || (shouldQualify ? quoteCompletionApplyIdentifier(ref.name, dialect) : undefined);
    const expansion = buildSelectAllColumnExpansion(columns, qualifier, !!context.qualifier, dialect, databaseType);
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

function buildInsertAllColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, t?: SqlCompletionTranslations, dialect?: SqlCompletionApplyDialect, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (!context.insertTable) return [];
  // The INSERT column prefix controls the replacement/filter range, but the
  // all-column snippet must always expand the complete target table.
  const columns = uniqueColumnsByName(columnsForInsertTarget(context, columnsByTable));
  if (columns.length === 0) return [];

  const label = `${context.insertTable}.*`;
  if (!selectAllColumnItemMatchesPrefix(label, { name: context.insertTable, schema: context.insertSchema }, columns, context.prefix)) return [];

  const columnList = columns.map((column) => quoteCompletionApplyIdentifier(column.name, dialect)).join(", ");
  const valuesKeyword = applySqlKeywordCase("VALUES", keywordCase);
  const valueList = columns.map((_, index) => `\${${index + 1}:value}`).join(", ");
  const expansion = `${columnList}) ${valuesKeyword} (${valueList})`;
  const preview = `${columnList}) ${valuesKeyword} (${columns.map(() => "value").join(", ")})`;
  const countText = (t?.starExpansionColumns ?? "{count} columns").replace("{count}", String(columns.length));
  return [
    {
      label,
      type: "snippet" as const,
      detail: `${countText}: ${preview.length > 60 ? preview.slice(0, 57) + "..." : preview}`,
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

function buildSelectAllColumnExpansion(columns: SqlCompletionColumn[], qualifier: string | undefined, qualifierAlreadyTyped: boolean, dialect?: SqlCompletionApplyDialect, databaseType?: DatabaseType): string {
  return columns
    .map((column, index) => {
      const columnName = quoteSelectStarColumnIdentifier(column.name, dialect, databaseType);
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
    for (const col of completionColumnPrefixCandidates(cols, unqualified, 256)) {
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
    items.push({ label: applySqlKeywordCase("TRUE", keywordCase), type: "keyword" as const, detail: t?.booleanValue ?? "Boolean value", boost: 1700 }, { label: applySqlKeywordCase("FALSE", keywordCase), type: "keyword" as const, detail: t?.booleanValue ?? "Boolean value", boost: 1650 });
  }

  return items;
}

function buildReferencedAliasItems(context: SqlCompletionContext, t?: SqlCompletionTranslations): SqlCompletionItem[] {
  const seen = new Set<string>();
  const items: SqlCompletionItem[] = [];
  for (const reference of context.referencedTables) {
    const alias = reference.alias?.trim();
    if (!alias || !matchesIdentifierSearch(alias, context.prefix)) continue;
    const key = normalizeIdentifierPart(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    const tableName = reference.schema ? `${reference.schema}.${reference.name}` : reference.name;
    items.push({
      label: alias,
      type: "text",
      detail: `${t?.tableAlias ?? "Table alias"} · ${tableName}`,
      apply: reference.aliasSql ?? alias,
      boost: 20_000 + identifierMatchScore(alias, context.prefix) - items.length,
    });
  }
  return items;
}

function buildAliasItems(context: SqlCompletionContext, databaseType?: DatabaseType, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
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
      apply: formatAliasCompletionApply(candidate, databaseType, keywordCase),
      boost: 1600 - items.length,
    });
  }
  return items;
}

function formatTableAliasApply(tableName: string, alias: string, databaseType?: DatabaseType, keywordCase?: SqlKeywordCase): string {
  if (!alias) return tableName;
  return isOracleLikeDatabase(databaseType) ? `${tableName} ${alias}` : `${tableName} ${applySqlKeywordCase("AS", keywordCase)} ${alias}`;
}

function formatAliasCompletionApply(alias: string, databaseType?: DatabaseType, keywordCase?: SqlKeywordCase): string {
  return isOracleLikeDatabase(databaseType) ? `${alias} ` : `${applySqlKeywordCase("AS", keywordCase)} ${alias} `;
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

function isInTableListContext(beforeToken: string, databaseType: DatabaseType | undefined): boolean {
  if (isInOrderOrGroupByContext(beforeToken)) return false;
  const cleaned = activeQueryBlockSql(maskSqlLiteralsAndComments(beforeToken, databaseType).trimEnd());
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

function activeQueryBlockSql(sql: string): string {
  let depth = 0;
  const selectIndexes = new Map<number, number>();
  const lower = sql.toLowerCase();

  for (let index = 0; index < lower.length; index += 1) {
    const ch = lower[index] ?? "";
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (lower.startsWith("select", index) && !isIdentifierPart(lower[index - 1]) && !isIdentifierPart(lower[index + 6])) {
      selectIndexes.set(depth, index);
      index += 5;
    }
  }

  const activeDepth = Math.max(...[...selectIndexes.keys()].filter((selectDepth) => selectDepth <= depth), -1);
  const activeSelectIndex = activeDepth >= 0 ? selectIndexes.get(activeDepth) : undefined;
  return activeSelectIndex == null ? sql : sql.slice(activeSelectIndex);
}

interface CompletionColumnSearchIndex {
  entries: Array<{ normalizedName: string; index: number }>;
}

const completionColumnSearchIndexes = new WeakMap<readonly SqlCompletionColumn[], CompletionColumnSearchIndex>();

function completionColumnSearchIndex(columns: readonly SqlCompletionColumn[]): CompletionColumnSearchIndex {
  const cached = completionColumnSearchIndexes.get(columns);
  if (cached) return cached;
  const index: CompletionColumnSearchIndex = {
    entries: columns.map((column, index) => ({ normalizedName: column.name.trim().toLowerCase(), index })).sort((left, right) => left.normalizedName.localeCompare(right.normalizedName) || left.index - right.index),
  };
  completionColumnSearchIndexes.set(columns, index);
  return index;
}

function completionColumnPrefixCandidates(columns: readonly SqlCompletionColumn[], prefix: string, limit = 256): SqlCompletionColumn[] {
  if (!prefix) return [...columns];
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!normalizedPrefix) return [...columns];
  const index = completionColumnSearchIndex(columns).entries;
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((index[middle]?.normalizedName ?? "") < normalizedPrefix) low = middle + 1;
    else high = middle;
  }
  const candidates: SqlCompletionColumn[] = [];
  const seen = new Set<number>();
  for (let position = low; position < index.length && candidates.length < limit; position += 1) {
    const entry = index[position];
    if (!entry || !entry.normalizedName.startsWith(normalizedPrefix)) break;
    const column = columns[entry.index];
    if (column) {
      candidates.push(column);
      seen.add(entry.index);
    }
  }
  // Preserve fuzzy/substring matching when the prefix index has not filled
  // the bounded candidate pool, while avoiding a second scan for the common
  // case where a prefix already has enough results.
  if (candidates.length < limit) {
    for (let indexPosition = 0; indexPosition < columns.length && candidates.length < limit; indexPosition += 1) {
      if (seen.has(indexPosition)) continue;
      const column = columns[indexPosition];
      if (!column || !matchesIdentifierSearch(column.name, prefix)) continue;
      candidates.push(column);
    }
  }
  return candidates;
}

function collectCompletionColumns(columnsByTable: Map<string, SqlCompletionColumn[]>, prefix = ""): Array<SqlCompletionColumn & { key: string }> {
  const allColumns: Array<SqlCompletionColumn & { key: string }> = [];
  for (const [key, cols] of columnsByTable.entries()) {
    for (const col of completionColumnPrefixCandidates(cols, prefix)) {
      allColumns.push({ ...col, key });
    }
  }
  return allColumns;
}

function columnsForInsertTarget(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>): Array<SqlCompletionColumn & { key: string }> {
  if (!context.insertTable) return [];
  const tableKey = normalizeIdentifierPart(context.insertTable);
  const schemaKey = context.insertSchema ? normalizeIdentifierPart(context.insertSchema) : undefined;
  const databaseKey = context.insertDatabase ? normalizeIdentifierPart(context.insertDatabase) : undefined;
  const qualifiedKey = schemaKey ? normalizeCompletionKey(`${context.insertDatabase ? `${context.insertDatabase}.` : ""}${context.insertSchema}.${context.insertTable}`) : undefined;
  return collectCompletionColumns(columnsByTable).filter((column) => {
    if (normalizeIdentifierPart(column.table) !== tableKey) return false;
    if (!schemaKey) return true;
    if (!databaseKey && column.schema && normalizeIdentifierPart(column.schema) === schemaKey) return true;
    return !!qualifiedKey && normalizeCompletionKey(column.key) === qualifiedKey;
  });
}

function buildColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: SqlCompletionApplyDialect): SqlCompletionItem[] {
  // Build a bounded candidate pool before doing duplicate detection, ranking,
  // and completion object materialization. Canonical column arrays remain the
  // source of truth; the per-array prefix index is only a derived accelerator.
  const allColumns = collectCompletionColumns(columnsByTable, context.prefix);

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
    const nameKey = normalizeIdentifierPart(c.name);
    nameCount.set(nameKey, (nameCount.get(nameKey) || 0) + 1);
  }

  // Multi-source queries always insert a qualified column. Duplicate names remain
  // separate choices so the user can select the intended row source.
  const qualifyAllColumns = !context.qualifier && !context.insertTable && context.referencedTables.length > 1;
  const seen = new Set<string>();
  const uniqueColumns: Array<SqlCompletionColumn & { key: string; displayLabel: string }> = [];
  for (const c of relevantCols) {
    const count = nameCount.get(normalizeIdentifierPart(c.name)) || 0;
    if (count > 1 || qualifyAllColumns) {
      const qualifier = c.sourceQualifierSql ?? c.sourceAlias ?? c.table;
      const qualifiedKey = `${qualifier}.${c.name}`;
      const normalizedQualifiedKey = normalizeCompletionKey(qualifiedKey);
      if (seen.has(normalizedQualifiedKey)) continue;
      seen.add(normalizedQualifiedKey);
      uniqueColumns.push({ ...c, key: c.key, displayLabel: `${qualifier}.${c.name}` });
    } else {
      const nameKey = normalizeIdentifierPart(c.name);
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);
      uniqueColumns.push({ ...c, key: c.key, displayLabel: c.name });
    }
  }

  // When the query already references concrete tables (or we are after a
  // "table." qualifier / in an INSERT column list), the columns of those
  // tables are what the user is most likely picking — boost them above plain
  // keywords so they rank at the top instead of being interleaved.
  const relevanceBoost = context.referencedTables.length > 0 || !!context.qualifier || !!context.insertTable ? 2000 : 0;

  const rankedColumns = uniqueColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => matchesIdentifierSearch(column.name, context.prefix) || matchesIdentifierSearch(column.displayLabel, context.prefix))
    .map(({ column, index }) => {
      const keyBoost = isKeyColumn(column.name) ? 500 : 0;
      const matchScore = Math.max(identifierMatchScore(column.name, context.prefix), identifierMatchScore(column.displayLabel, context.prefix));
      return { column, index, boost: matchScore + keyBoost + relevanceBoost };
    })
    .sort((left, right) => right.boost - left.boost || left.index - right.index)
    .slice(0, context.insertTable || !context.prefix ? 50 : context.qualifier ? 30 : 20);

  return rankedColumns.map(({ column, boost }) => {
    return {
      label: column.displayLabel,
      filterText: column.displayLabel === column.name ? undefined : column.name,
      type: "column" as const,
      detail: buildColumnDetail(column),
      info: buildColumnInfo(column),
      apply: buildColumnApply(column, context, dialect),
      boost,
    };
  });
}

function completionColumnsForReferencedTable<T extends SqlCompletionColumn & { key: string }>(table: SqlCompletionReferencedTable, columns: readonly T[]): T[] {
  const matched = columns.filter((column) => columnMatchesReferencedTable(column, table));
  const aliasedColumns = applyReferencedColumnAliases(table, matched);
  if (!table.alias) return aliasedColumns;
  return aliasedColumns.map((column) => ({ ...column, sourceAlias: table.alias, sourceQualifierSql: table.aliasSql }));
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
  return context.referencedTables.some((table) => completionColumnPrefixCandidates(columnsForReferencedTable(table, columnsByTable), context.prefix, 1).length > 0);
}

function qualifiedTableTargetFromContext(context: SqlCompletionContext): { database?: string; schema: string; table: string } | null {
  const parts = context.qualifierParts ?? context.qualifier?.split(".").filter(Boolean) ?? [];
  if (parts.length < 2) return null;
  const table = parts[parts.length - 1];
  const schema = parts[parts.length - 2];
  if (!schema || !table) return null;
  const database = parts.length >= 3 ? parts[parts.length - 3] : undefined;
  return { database, schema, table };
}

function referencedTableMatchesColumnQualifier(table: SqlCompletionReferencedTable, qualifier: string, qualifierLower: string, qualifiedTarget: { database?: string; schema: string; table: string } | null): boolean {
  if (table.alias === qualifier || table.alias?.toLowerCase() === qualifierLower) return true;
  if (table.name === qualifier || table.name.toLowerCase() === qualifierLower) return true;
  if (!qualifiedTarget) return false;
  if (normalizeIdentifierPart(table.name) !== normalizeIdentifierPart(qualifiedTarget.table)) return false;
  if (table.database && qualifiedTarget.database && normalizeIdentifierPart(table.database) !== normalizeIdentifierPart(qualifiedTarget.database)) return false;
  return !table.schema || normalizeIdentifierPart(table.schema) === normalizeIdentifierPart(qualifiedTarget.schema);
}

function columnMatchesReferencedTable(column: SqlCompletionColumn & { key: string }, table: SqlCompletionReferencedTable): boolean {
  if (normalizeIdentifierPart(column.table) !== normalizeIdentifierPart(table.name)) return false;
  if (!table.schema) return true;
  return columnMatchesQualifiedTable(column, { database: table.database, schema: table.schema, table: table.name });
}

function columnMatchesQualifiedTable(column: SqlCompletionColumn & { key: string }, target: { database?: string; schema: string; table: string }): boolean {
  if (normalizeIdentifierPart(column.table) !== normalizeIdentifierPart(target.table)) return false;
  if (!target.database && column.schema && normalizeIdentifierPart(column.schema) === normalizeIdentifierPart(target.schema)) return true;
  const key = `${target.database ? `${target.database}.` : ""}${target.schema}.${target.table}`;
  return normalizeCompletionKey(column.key) === normalizeCompletionKey(key);
}

function normalizeCompletionKey(key: string): string {
  return key
    .split(".")
    .filter(Boolean)
    .map((part) => normalizeIdentifierPart(part))
    .join(".");
}

function buildColumnApply(column: SqlCompletionColumn & { displayLabel: string }, context: SqlCompletionContext, dialect?: SqlCompletionApplyDialect): string {
  if (context.qualifier || column.displayLabel === column.name || !column.displayLabel.includes(".")) {
    return quoteCompletionApplyIdentifier(column.name, dialect);
  }
  const qualifier = column.sourceQualifierSql ?? quoteCompletionApplyIdentifier(column.sourceAlias ?? column.table, dialect);
  return `${qualifier}.${quoteCompletionApplyIdentifier(column.name, dialect)}`;
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
  return detail;
}

function buildColumnInfo(column: SqlCompletionColumn): string | undefined {
  const hasDetails = !!column.dataType || column.isNullable !== undefined || !!column.comment?.trim();
  if (!hasDetails) return undefined;
  const title = column.schema ? `${column.schema}.${column.table}.${column.name}` : `${column.table}.${column.name}`;
  const details = [column.dataType ? `Type: ${column.dataType}` : undefined, column.isNullable === false ? "Nullable: no" : column.isNullable === true ? "Nullable: yes" : undefined, column.comment?.trim() ? `Comment: ${column.comment.trim()}` : undefined].filter((part): part is string => !!part);
  return [title, ...details].join("\n");
}

function buildJoinConditionItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>, dialect?: SqlCompletionApplyDialect, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
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
  const keys = table.schema ? [table.database ? `${table.database}.${table.schema}.${table.name}` : undefined, `${table.schema}.${table.name}`, table.name].filter((key): key is string => !!key) : [table.name];
  for (const key of keys) {
    const columns = columnsByTable.get(key);
    if (columns) return applyReferencedColumnAliases(table, columns);
  }
  return [];
}

function foreignKeysForReferencedTable(table: SqlCompletionReferencedTable, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>): SqlCompletionForeignKey[] {
  if (!foreignKeysByTable) return [];
  const keys = table.schema ? [table.database ? `${table.database}.${table.schema}.${table.name}` : undefined, `${table.schema}.${table.name}`, table.name].filter((key): key is string => !!key) : [table.name];
  for (const key of keys) {
    const foreignKeys = foreignKeysByTable.get(key);
    if (foreignKeys) return foreignKeys;
  }
  return [];
}

function buildForeignKeyJoinConditionItemsForPair(left: SqlCompletionReferencedTable, right: SqlCompletionReferencedTable, foreignKeysByTable?: Map<string, SqlCompletionForeignKey[]>, prefix = "", dialect?: SqlCompletionApplyDialect, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (!foreignKeysByTable) return [];
  return [
    ...buildDirectionalForeignKeyJoinConditionItems(left, right, foreignKeysForReferencedTable(left, foreignKeysByTable), prefix, dialect, keywordCase),
    ...buildDirectionalForeignKeyJoinConditionItems(right, left, foreignKeysForReferencedTable(right, foreignKeysByTable), prefix, dialect, keywordCase),
  ];
}

function buildDirectionalForeignKeyJoinConditionItems(owner: SqlCompletionReferencedTable, referenced: SqlCompletionReferencedTable, foreignKeys: SqlCompletionForeignKey[], prefix: string, dialect?: SqlCompletionApplyDialect, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
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

function buildJoinConditionPart(owner: SqlCompletionReferencedTable, ownerColumn: string, referenced: SqlCompletionReferencedTable, referencedColumn: string, dialect?: SqlCompletionApplyDialect): { label: string; apply: string } {
  const ownerRef = owner.alias || owner.name;
  const referencedRef = referenced.alias || referenced.name;
  const ownerApplyRef = owner.alias ? owner.alias : quoteCompletionApplyIdentifier(owner.name, dialect);
  const referencedApplyRef = referenced.alias ? referenced.alias : quoteCompletionApplyIdentifier(referenced.name, dialect);
  return {
    label: `${ownerRef}.${ownerColumn} = ${referencedRef}.${referencedColumn}`,
    apply: `${ownerApplyRef}.${quoteCompletionApplyIdentifier(ownerColumn, dialect)} = ${referencedApplyRef}.${quoteCompletionApplyIdentifier(referencedColumn, dialect)}`,
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

function buildJoinConditionItemsForPair(left: SqlCompletionReferencedTable, leftColumns: SqlCompletionColumn[], right: SqlCompletionReferencedTable, rightColumns: SqlCompletionColumn[], prefix: string, dialect?: SqlCompletionApplyDialect, keywordCase?: SqlKeywordCase): SqlCompletionItem[] {
  const items: SqlCompletionItem[] = [];
  const leftRef = left.alias || left.name;
  const rightRef = right.alias || right.name;
  const leftApplyRef = left.alias ? left.alias : quoteCompletionApplyIdentifier(left.name, dialect);
  const rightApplyRef = right.alias ? right.alias : quoteCompletionApplyIdentifier(right.name, dialect);
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
    const apply = `${leftApplyRef}.${quoteCompletionApplyIdentifier(leftColumn.name, dialect)} = ${rightApplyRef}.${quoteCompletionApplyIdentifier(rightColumn.name, dialect)}`;
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
  dialect?: SqlCompletionApplyDialect,
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
  const leftApplyRef = left.alias ? left.alias : quoteCompletionApplyIdentifier(left.name, dialect);
  const rightApplyRef = right.alias ? right.alias : quoteCompletionApplyIdentifier(right.name, dialect);
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

function buildHeuristicJoinConditionPart(leftRef: string, leftApplyRef: string, leftColumn: SqlCompletionColumn, rightRef: string, rightApplyRef: string, rightColumn: SqlCompletionColumn, dialect?: SqlCompletionApplyDialect): { label: string; apply: string } {
  return {
    label: `${leftRef}.${leftColumn.name} = ${rightRef}.${rightColumn.name}`,
    apply: `${leftApplyRef}.${quoteCompletionApplyIdentifier(leftColumn.name, dialect)} = ${rightApplyRef}.${quoteCompletionApplyIdentifier(rightColumn.name, dialect)}`,
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

export function buildSnippetItemsForTest(prefix: string, snippets: SqlSnippet[], keywordCase?: SqlKeywordCase, databaseType?: DatabaseType): SqlCompletionItem[] {
  return buildSnippetItems(prefix, snippets, keywordCase, databaseType);
}

function buildSnippetItems(prefix: string, snippets: SqlSnippet[], keywordCase?: SqlKeywordCase, databaseType?: DatabaseType): SqlCompletionItem[] {
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
      const resolvedBody = resolveSqlSnippetBodyForDatabase(snippet, databaseType);
      const body = applyBuiltinSnippetKeywordCase(snippet, resolvedBody, keywordCase);
      const apply = applyBuiltinSnippetKeywordCase(snippet, applyBuiltinSnippetPlaceholders(snippet, resolvedBody), keywordCase);
      return {
        label: snippet.label,
        filterText: snippet.prefix,
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

function formatFunctionSignatureApply(definition: ClickHouseFunctionDefinition, omitOpeningParen: boolean): string {
  if (omitOpeningParen) return definition.name;
  const signature = definition.signatures[definition.preferredSignature ?? 0];
  return (
    definition.name +
    signature.parameterGroups
      .map(
        (group) =>
          `(${group
            .filter((parameter) => !parameter.endsWith("?"))
            .map((parameter) => `\${${parameter}}`)
            .join(", ")})`,
      )
      .join("")
  );
}

function clickHouseFunctionDetail(definition: ClickHouseFunctionDefinition): string {
  const status = definition.status && definition.status !== "stable" ? ` · ${definition.status}` : "";
  const overloads = definition.signatures.length > 1 ? ` · ${definition.signatures.length} overloads` : "";
  return `ClickHouse · ${definition.category}${overloads}${status}`;
}

function buildClickHouseFunctionItems(prefix: string, omitOpeningParen: boolean, kind?: ClickHouseFunctionKind): SqlCompletionItem[] {
  return searchClickHouseFunctions(prefix, 200, kind).map((definition) => {
    const statusPenalty = definition.status === "deprecated" ? -600 : definition.status === "experimental" ? -300 : 0;
    const generatedPenalty = definition.generated ? -75 : 0;
    return {
      label: definition.name,
      type: "function" as const,
      detail: clickHouseFunctionDetail(definition),
      info: definition.description,
      apply: formatFunctionSignatureApply(definition, omitOpeningParen),
      boost: computeBoost(definition.name, prefix) + 300 + statusPenalty + generatedPenalty,
    };
  });
}

function buildFunctionSnippetItems(prefix: string, functionDescriptions: Map<string, string>, databaseType?: DatabaseType, omitOpeningParen = false, keywordCase?: SqlKeywordCase, functionCase?: SqlKeywordCase): SqlCompletionItem[] {
  if (databaseType === "clickhouse") return buildClickHouseFunctionItems(prefix, omitOpeningParen);
  const items: SqlCompletionItem[] = [];

  for (const [name, parameters] of activeFunctionSignatures(databaseType).entries()) {
    if (!matchesPrefix(name, prefix)) continue;
    const functionName = applySqlFunctionCase(name, functionCase);
    const paramStr = parameters.length > 0 ? parameters.map((p) => `\${${applyGeneratedSqlTemplateKeywordCase(p, keywordCase)}}`).join(", ") : "";
    const mysqlApply = databaseType === "mysql" ? MYSQL_FUNCTION_APPLY_TEMPLATES.get(name) : undefined;
    items.push({
      label: functionName,
      type: "function" as const,
      detail: functionDescriptions.get(name) ?? "function",
      apply: mysqlApply ? `${functionName}${applyGeneratedSqlTemplateKeywordCase(mysqlApply.slice(name.length), keywordCase)}` : `${functionName}(${paramStr})`,
      boost: computeBoost(name, prefix) + 300,
    });
  }

  // Window functions — complete with OVER() clause
  for (const name of WINDOW_FUNCTIONS) {
    if (!matchesPrefix(name, prefix)) continue;
    const functionName = applySqlFunctionCase(name, functionCase);
    items.push({
      label: functionName,
      type: "function" as const,
      detail: "window function",
      apply: applyGeneratedSqlTemplateKeywordCase(`${functionName}() OVER (PARTITION BY \${col} ORDER BY \${col})`, keywordCase),
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

function buildGroupByAllSelectAliasItem(context: SqlCompletionContext, selectAliasItems: SqlCompletionItem[], columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: SqlCompletionApplyDialect): SqlCompletionItem | null {
  const nonAggregatedAliases = new Set(context.nonAggregatedSelectColumns.map((column) => column.toLowerCase()));
  const columnApplyByName = new Map(buildNonAggregatedColumnItems(context, columnsByTable, dialect).map((item) => [item.label.toLowerCase(), item.apply ?? item.label]));
  const seen = new Set<string>();
  const safeAliasItems = selectAliasItems.filter((item) => {
    const key = item.label.toLowerCase();
    if (!nonAggregatedAliases.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (safeAliasItems.length < 2) return null;

  return {
    label: safeAliasItems.map((item) => item.label).join(", "),
    type: "snippet",
    detail: "All non-aggregated SELECT aliases",
    apply: safeAliasItems.map((item) => columnApplyByName.get(item.label.toLowerCase()) ?? item.apply ?? item.label).join(", "),
    boost: 3650,
    dedupeKey: "group-by-all-select-aliases",
  };
}

function buildNonAggregatedColumnItems(context: SqlCompletionContext, columnsByTable: Map<string, SqlCompletionColumn[]>, dialect?: SqlCompletionApplyDialect): SqlCompletionItem[] {
  const nonAggSet = new Set(context.nonAggregatedSelectColumns.map((c) => c.toLowerCase()));
  const seen = new Set<string>();

  const items: SqlCompletionItem[] = [];
  for (const [, cols] of columnsByTable) {
    for (const col of completionColumnPrefixCandidates(cols, context.prefix, 256)) {
      const key = col.name.toLowerCase();
      if (!nonAggSet.has(key) || seen.has(key)) continue;
      if (context.prefix && !matchesIdentifierSearch(col.name, context.prefix)) continue;
      seen.add(key);
      items.push({
        label: col.name,
        type: "column" as const,
        detail: "non-aggregated column — required in GROUP BY",
        apply: quoteCompletionApplyIdentifier(col.name, dialect),
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
      if (functionSignatures.has(keyword) && !DATA_TYPE_KEYWORDS.has(keyword) && !DUAL_ROLE_SQL_KEYWORDS.has(keyword)) return false;
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
 *   Pinyin initials: 2300 + exactInitialsBonus - len  (ASCII query vs Han candidate, e.g. "zzj" → 总租金)
 *   Pinyin subsequence: 1600 - penalties - len  (ordered initials, e.g. "zj" → 总租金)
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

  // DataGrip-style pinyin initials: an ASCII query matches the first pinyin
  // letters of Han characters — as a prefix ("zz" → 总租金) or as an ordered
  // subsequence ("zj" → 总租金, "j" → 总租金).
  if (/^[a-z0-9]+$/.test(p) && containsHan(c)) {
    const pinyinInitials = pinyinFirstLetters(c);
    if (pinyinInitials.startsWith(p)) {
      const exactInitialsBonus = pinyinInitials === p ? 300 : 0;
      return 2300 + exactInitialsBonus - c.length;
    }
    const subsequence = orderedSubsequenceSpan(pinyinInitials, p);
    if (subsequence) {
      return 1600 - subsequence.first * 30 - (subsequence.span - p.length) * 10 - c.length;
    }
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
const COMPLETION_STATS_MAX_ENTRIES = 512;
const completionStats = new Map<string, number>();

/** Record a user selection to boost future rankings. */
export function recordCompletionSelection(label: string, type: string): void {
  const key = `${type}:${label}`;
  const count = completionStats.get(key) || 0;
  completionStats.delete(key);
  completionStats.set(key, count + 1);
  while (completionStats.size > COMPLETION_STATS_MAX_ENTRIES) {
    const oldest = completionStats.keys().next().value;
    if (oldest === undefined) break;
    completionStats.delete(oldest);
  }
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
  if ((left.type === "variable") !== (right.type === "variable")) return left.type === "variable" ? -1 : 1;
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
    case "variable":
      return 220;
    case "text":
      return 220;
    case "function":
      return 90;
    case "snippet":
      return 40;
    case "keyword":
      return 0;
  }
}

interface ActiveFunctionCall {
  name: string;
  activeGroup: number;
  groupText: string;
}

function findActiveFunctionCall(sqlBeforeCursor: string): ActiveFunctionCall | null {
  const activeOpenParen = findActiveFunctionOpenParen(sqlBeforeCursor);
  if (activeOpenParen == null) return null;

  const beforeActiveGroup = sqlBeforeCursor.slice(0, activeOpenParen).trimEnd();
  const ordinaryName = /([A-Za-z_][\w$]*)$/.exec(beforeActiveGroup)?.[1];
  if (ordinaryName) {
    return {
      name: ordinaryName,
      activeGroup: 0,
      groupText: sqlBeforeCursor.slice(activeOpenParen + 1),
    };
  }

  if (!beforeActiveGroup.endsWith(")")) return null;
  const firstGroupOpenParen = findMatchingOpenParen(beforeActiveGroup, beforeActiveGroup.length - 1);
  if (firstGroupOpenParen == null) return null;
  const parametricName = /([A-Za-z_][\w$]*)$/.exec(beforeActiveGroup.slice(0, firstGroupOpenParen).trimEnd())?.[1];
  if (!parametricName) return null;
  return {
    name: parametricName,
    activeGroup: 1,
    groupText: sqlBeforeCursor.slice(activeOpenParen + 1),
  };
}

function findMatchingOpenParen(text: string, closeParenIndex: number): number | null {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let index = closeParenIndex; index >= 0; index -= 1) {
    const character = text[index];
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (character === ")") depth += 1;
    else if (character === "(") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
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
