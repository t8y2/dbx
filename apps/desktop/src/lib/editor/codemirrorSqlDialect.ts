import type { SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseType } from "@/types/database";

export type CodeMirrorSqlDialectName = "mysql" | "postgres" | "sqlserver";

type CodeMirrorSqlLanguageModule = Pick<typeof import("@codemirror/lang-sql"), "Cassandra" | "MSSQL" | "MySQL" | "PLSQL" | "PostgreSQL" | "SQLite" | "SQLDialect" | "StandardSQL">;

const MYSQL_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["mysql", "doris", "starrocks", "manticoresearch", "goldendb", "gbase"]);
const POSTGRES_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase", "opengauss", "questdb"]);
const ORACLE_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "dameng", "yashandb", "oscar", "oceanbase-oracle"]);
const SQLITE_CODEMIRROR_DATABASE_TYPES = new Set<DatabaseType>(["sqlite", "rqlite", "turso", "cloudflare-d1"]);

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

export function postgresKeywordSyntaxTerms(keywords: string): string {
  return keywords
    .split(/\s+/)
    .filter((keyword) => keyword && !POSTGRES_IDENTIFIER_LIKE_KEYWORDS.has(keyword.toUpperCase()))
    .join(" ");
}

function codeMirrorBaseDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName, databaseType?: DatabaseType): SQLDialect {
  if (databaseType) {
    if (MYSQL_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.MySQL;
    if (POSTGRES_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.PostgreSQL;
    if (ORACLE_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.PLSQL;
    if (SQLITE_CODEMIRROR_DATABASE_TYPES.has(databaseType)) return langSql.SQLite;
    if (databaseType === "sqlserver") return langSql.MSSQL;
    if (databaseType === "cassandra") return langSql.Cassandra;
    return langSql.StandardSQL;
  }
  return dialectName === "postgres" ? langSql.PostgreSQL : dialectName === "sqlserver" ? langSql.MSSQL : langSql.MySQL;
}

export function createDbxCodeMirrorSqlDialect(langSql: CodeMirrorSqlLanguageModule, dialectName: CodeMirrorSqlDialectName = "mysql", databaseType?: DatabaseType): SQLDialect {
  const baseDialect = codeMirrorBaseDialect(langSql, dialectName, databaseType);
  const isPostgres = baseDialect === langSql.PostgreSQL;
  const isSqlServer = baseDialect === langSql.MSSQL;
  const baseKeywords = isPostgres ? postgresKeywordSyntaxTerms(baseDialect.spec.keywords || "") : baseDialect.spec.keywords || "";

  return langSql.SQLDialect.define({
    ...baseDialect.spec,
    keywords: [baseKeywords, DBX_COMMON_SQL_KEYWORDS, isPostgres ? POSTGRES_PLPGSQL_KEYWORDS : "", isSqlServer ? SQLSERVER_KEYWORDS : ""].filter(Boolean).join(" "),
    types: [baseDialect.spec.types || "", isPostgres ? POSTGRES_PLPGSQL_TYPES : ""].filter(Boolean).join(" ") || undefined,
    builtin: [baseDialect.spec.builtin || "", isPostgres ? POSTGRES_PLPGSQL_BUILTIN : ""].filter(Boolean).join(" ") || undefined,
    doubleDollarQuotedStrings: false,
  });
}
