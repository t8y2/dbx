import type { DatabaseType, SqlSnippet } from "@/types/database";

const DEFAULT_SELECT_ROW_LIMIT = 100;

/**
 * Built-in SQL snippets shared by database types.
 *
 * Database-specific bodies are resolved at completion time so the stored
 * defaults remain portable and existing user-customized bodies stay intact.
 */
export const DEFAULT_SQL_SNIPPETS: SqlSnippet[] = [
  {
    id: "builtin-sel",
    label: "select *",
    prefix: "sel",
    body: `SELECT *\nFROM table\nLIMIT ${DEFAULT_SELECT_ROW_LIMIT};`,
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

/** Additional snippets only exposed by the Manticore Search completion path. */
export const MANTICORESEARCH_SQL_SNIPPETS: SqlSnippet[] = [
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

type BuiltinSqlSnippetBodyBuilder = (databaseType?: DatabaseType) => string;

interface BuiltinSqlSnippetRule {
  defaultBody: string;
  buildBody: BuiltinSqlSnippetBodyBuilder;
}

type SelectSnippetLimitStyle = "limit" | "top" | "first" | "fetch-first" | "rows" | "rownum" | "unbounded";

const SELECT_SNIPPET_LIMIT_STYLE_BY_DATABASE: Partial<Record<DatabaseType, SelectSnippetLimitStyle>> = {
  oracle: "rownum",
  "oceanbase-oracle": "rownum",
  oscar: "rownum",
  dameng: "fetch-first",
  db2: "fetch-first",
  sqlserver: "top",
  access: "top",
  iris: "top",
  teradata: "top",
  informix: "first",
  firebird: "rows",
  // An unknown JDBC driver may expose any SQL dialect. Known JDBC profiles are
  // converted to their effective database type before reaching the editor.
  jdbc: "unbounded",
};

const PARENTHESIZED_ADD_COLUMN_DATABASES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "yashandb", "xugu", "dameng", "iris", "informix"]);
const ADD_COLUMN_WITHOUT_COLUMN_KEYWORD_DATABASES = new Set<DatabaseType>(["sqlserver", "kingbase", "cassandra", "teradata"]);

function buildSelectSnippetBody(databaseType?: DatabaseType): string {
  const style = databaseType ? (SELECT_SNIPPET_LIMIT_STYLE_BY_DATABASE[databaseType] ?? "limit") : "limit";
  switch (style) {
    case "top":
      return `SELECT TOP ${DEFAULT_SELECT_ROW_LIMIT} *\nFROM table;`;
    case "first":
      return `SELECT FIRST ${DEFAULT_SELECT_ROW_LIMIT} *\nFROM table;`;
    case "fetch-first":
      return `SELECT *\nFROM table\nFETCH FIRST ${DEFAULT_SELECT_ROW_LIMIT} ROWS ONLY;`;
    case "rows":
      return `SELECT *\nFROM table\nROWS ${DEFAULT_SELECT_ROW_LIMIT};`;
    case "rownum":
      return `SELECT *\nFROM table\nWHERE ROWNUM <= ${DEFAULT_SELECT_ROW_LIMIT};`;
    case "unbounded":
      return "SELECT *\nFROM table;";
    case "limit":
      return `SELECT *\nFROM table\nLIMIT ${DEFAULT_SELECT_ROW_LIMIT};`;
  }
}

function buildUpdateSnippetBody(databaseType?: DatabaseType): string {
  if (databaseType === "clickhouse") {
    return "ALTER TABLE table\nUPDATE column = value\nWHERE condition;";
  }
  return "UPDATE table\nSET column = value\nWHERE condition;";
}

function buildAlterTableAddColumnSnippetBody(databaseType?: DatabaseType): string {
  if (databaseType && PARENTHESIZED_ADD_COLUMN_DATABASES.has(databaseType)) {
    return "ALTER TABLE table\nADD (column type);";
  }
  if (databaseType && ADD_COLUMN_WITHOUT_COLUMN_KEYWORD_DATABASES.has(databaseType)) {
    return "ALTER TABLE table\nADD column type;";
  }
  return "ALTER TABLE table\nADD COLUMN column type;";
}

const BUILTIN_SQL_SNIPPET_RULES = new Map<string, BuiltinSqlSnippetRule>(
  DEFAULT_SQL_SNIPPETS.map((snippet) => [
    snippet.id,
    {
      defaultBody: snippet.body,
      buildBody: () => snippet.body,
    },
  ]),
);

function registerBuiltinSqlSnippetRule(id: string, buildBody: BuiltinSqlSnippetBodyBuilder): void {
  const rule = BUILTIN_SQL_SNIPPET_RULES.get(id);
  if (!rule) throw new Error(`Unknown built-in SQL snippet: ${id}`);
  BUILTIN_SQL_SNIPPET_RULES.set(id, { defaultBody: rule.defaultBody, buildBody });
}

registerBuiltinSqlSnippetRule("builtin-sel", buildSelectSnippetBody);
registerBuiltinSqlSnippetRule("builtin-upd", buildUpdateSnippetBody);
registerBuiltinSqlSnippetRule("builtin-at", buildAlterTableAddColumnSnippetBody);

export function resolveSqlSnippetBodyForDatabase(snippet: SqlSnippet, databaseType?: DatabaseType): string {
  const rule = BUILTIN_SQL_SNIPPET_RULES.get(snippet.id);
  if (!rule || snippet.body !== rule.defaultBody) return snippet.body;
  return rule.buildBody(databaseType);
}
