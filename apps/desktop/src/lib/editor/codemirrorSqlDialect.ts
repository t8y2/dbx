import type { SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseType } from "@/types/database";

export type CodeMirrorSqlDialectName = "mysql" | "postgres" | "sqlserver" | "clickhouse";

type CodeMirrorSqlLanguageModule = Pick<typeof import("@codemirror/lang-sql"), "Cassandra" | "MSSQL" | "MySQL" | "PLSQL" | "PostgreSQL" | "SQLite" | "SQLDialect" | "StandardSQL">;

const MYSQL_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["mysql", "doris", "starrocks", "manticoresearch", "goldendb", "gbase"]);
const POSTGRES_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss", "questdb"]);
const ORACLE_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "dameng", "yashandb", "oscar", "oceanbase-oracle"]);
const SQLITE_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["sqlite", "rqlite", "turso", "cloudflare-d1"]);

const CODEMIRROR_SQLITE_EXTENSION_KEYWORDS = new Set("abort analyze attach autoincrement conflict database detach exclusive fail glob ignore index indexed instead isnull notnull offset plan pragma query raise regexp reindex rename replace temp vacuum virtual".split(" "));
const STANDARD_SQL_TYPES = "array binary bit boolean char character clob date decimal double float int integer interval large national nchar nclob numeric object precision real smallint time timestamp varchar varying";

const DBX_COMMON_SQL_KEYWORDS = [
  "PIVOT",
  "UNPIVOT",
  "EXCLUDE",
  "REPLACE",
  "QUALIFY",
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
  "UNNEST",
  "LATERAL",
  "FILTER",
  "RECURSIVE",
  "SUMMARIZE",
  "PRAGMA",
  "READ_CSV",
  "READ_PARQUET",
  "READ_JSON",
  "DESCRIBE",
  "SHOW",
  "COPY",
  "EXPORT",
  "IMPORT",
].join(" ");

const POSTGRES_PLPGSQL_KEYWORDS = "PERFORM";
const POSTGRES_PLPGSQL_TYPES = "RECORD JSON JSONB";
const POSTGRES_PLPGSQL_BUILTIN = "SQLERRM TG_NAME TG_WHEN TG_LEVEL TG_OP TG_RELID TG_RELNAME TG_TABLE_NAME TG_TABLE_SCHEMA TG_NARGS TG_ARGV";
const POSTGRES_IDENTIFIER_LIKE_KEYWORDS = new Set("COMMENT COUNT DATA DAY HOUR ID KEY LEVEL MINUTE MONTH NAME OWNER PASSWORD POSITION ROLE SECOND TYPE USER VALUE YEAR".split(" "));

// SQL Server table-valued parameters require READONLY in procedure/function declarations.
const SQLSERVER_KEYWORDS = "readonly";

const CLICKHOUSE_KEYWORDS = [
  "ATTACH",
  "DETACH",
  "OPTIMIZE",
  "SYSTEM",
  "KILL",
  "ENGINE",
  "PARTITION",
  "PRIMARY",
  "SAMPLE",
  "PREWHERE",
  "ARRAY",
  "GLOBAL",
  "FINAL",
  "TOTALS",
  "ROLLUP",
  "CUBE",
  "LIMIT",
  "BY",
  "INTO",
  "OUTFILE",
  "COMPRESSION",
  "FORMAT",
  "SETTINGS",
  "TTL",
  "CODEC",
  "MATERIALIZED",
  "ALIAS",
  "PROJECTION",
  "INDEX",
  "GRANULARITY",
]
  .join(" ")
  .toLowerCase();

const CLICKHOUSE_TYPES = [
  "Bool",
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
  "Float32",
  "Float64",
  "Decimal",
  "Decimal32",
  "Decimal64",
  "Decimal128",
  "Decimal256",
  "String",
  "FixedString",
  "Date",
  "Date32",
  "DateTime",
  "DateTime64",
  "Time",
  "Time64",
  "Enum8",
  "Enum16",
  "UUID",
  "IPv4",
  "IPv6",
  "Array",
  "Tuple",
  "Map",
  "Nested",
  "Nullable",
  "LowCardinality",
  "AggregateFunction",
  "SimpleAggregateFunction",
  "JSON",
  "Object",
  "Variant",
  "Dynamic",
  "Nothing",
]
  .join(" ")
  .toLowerCase();

const CLICKHOUSE_BUILTINS = ["now", "today", "toDate", "toDateTime", "toDateTime64", "toYYYYMM", "count", "sum", "avg", "min", "max", "uniq", "uniqExact", "argMin", "argMax", "groupArray", "arrayJoin", "mapKeys", "mapValues", "JSONExtract", "JSONExtractString"].join(" ").toLowerCase();

export function postgresKeywordSyntaxTerms(keywords: string): string {
  return keywords
    .split(/\s+/)
    .filter((keyword) => keyword && !POSTGRES_IDENTIFIER_LIKE_KEYWORDS.has(keyword.toUpperCase()))
    .join(" ");
}

function standardSqlKeywordSyntaxTerms(langSql: CodeMirrorSqlLanguageModule): string {
  // CodeMirror keeps StandardSQL's default vocabulary internal and exposes an
  // empty StandardSQL.spec. SQLite is its smallest public standard-SQL
  // superset, so remove SQLite-only terms to retain the standard vocabulary.
  return (langSql.SQLite.spec.keywords || "")
    .split(/\s+/)
    .filter((keyword) => keyword && !CODEMIRROR_SQLITE_EXTENSION_KEYWORDS.has(keyword))
    .join(" ");
}

function codeMirrorBaseDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName, databaseType?: DatabaseType): SQLDialect {
  if (databaseType) {
    if (databaseType === "clickhouse") return langSql.StandardSQL;
    if (MYSQL_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.MySQL;
    if (POSTGRES_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.PostgreSQL;
    if (ORACLE_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.PLSQL;
    if (SQLITE_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.SQLite;
    if (databaseType === "sqlserver") return langSql.MSSQL;
    if (databaseType === "cassandra") return langSql.Cassandra;
    if (databaseType === "jdbc" && dialectName === "sqlserver") return langSql.MSSQL;
    return langSql.StandardSQL;
  }
  if (dialectName === "clickhouse") return langSql.StandardSQL;
  return dialectName === "postgres" ? langSql.PostgreSQL : dialectName === "sqlserver" ? langSql.MSSQL : langSql.MySQL;
}

export function createDbxCodeMirrorSqlDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName = "mysql", databaseType?: DatabaseType): SQLDialect {
  const baseDialect = codeMirrorBaseDialect(langSql, dialectName, databaseType);
  const isPostgres = baseDialect === langSql.PostgreSQL;
  const isSqlServer = baseDialect === langSql.MSSQL;
  const isClickHouse = databaseType === "clickhouse" || dialectName === "clickhouse";
  const baseKeywords = isClickHouse ? standardSqlKeywordSyntaxTerms(langSql) : isPostgres ? postgresKeywordSyntaxTerms(baseDialect.spec.keywords || "") : baseDialect.spec.keywords || "";
  const baseTypes = isClickHouse ? STANDARD_SQL_TYPES : baseDialect.spec.types || "";
  const commonKeywords = isClickHouse ? DBX_COMMON_SQL_KEYWORDS.toLowerCase() : DBX_COMMON_SQL_KEYWORDS;

  return langSql.SQLDialect.define({
    ...baseDialect.spec,
    keywords: [baseKeywords, commonKeywords, isClickHouse ? CLICKHOUSE_KEYWORDS : "", isPostgres ? POSTGRES_PLPGSQL_KEYWORDS : "", isSqlServer ? SQLSERVER_KEYWORDS : ""].filter(Boolean).join(" "),
    types: [baseTypes, isClickHouse ? CLICKHOUSE_TYPES : "", isPostgres ? POSTGRES_PLPGSQL_TYPES : ""].filter(Boolean).join(" ") || undefined,
    builtin: [baseDialect.spec.builtin || "", isClickHouse ? CLICKHOUSE_BUILTINS : "", isPostgres ? POSTGRES_PLPGSQL_BUILTIN : ""].filter(Boolean).join(" ") || undefined,
    ...(isClickHouse
      ? {
          identifierQuotes: '"`',
          backslashEscapes: true,
          spaceAfterDashes: false,
        }
      : {}),
    doubleDollarQuotedStrings: false,
  });
}
