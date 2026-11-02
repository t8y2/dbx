import type { DatabaseType } from "@/types/database";

/** Default row limit for built-in `sel` snippets. */
export const DEFAULT_SELECT_ROW_LIMIT = 100;

/** Default row limit for SQL quick-action "select first N" kind. */
export const DEFAULT_SQL_SHORTCUT_SELECT_LIMIT = 10;

export type SelectLimitStyle = "limit" | "top" | "first" | "fetch-first" | "rows" | "rownum";

const SELECT_LIMIT_STYLE_BY_DATABASE: Partial<Record<DatabaseType, SelectLimitStyle>> = {
  oracle: "rownum",
  "oceanbase-oracle": "rownum",
  oscar: "rownum",
  dameng: "rownum",
  db2: "fetch-first",
  sqlserver: "top",
  access: "top",
  iris: "top",
  teradata: "top",
  informix: "first",
  firebird: "rows",
  // Unknown JDBC dialects fall through to LIMIT (most common / safest default).
  // Known JDBC profiles are converted to their effective database type before
  // reaching the editor.
};

export function selectLimitStyleForDatabase(databaseType?: DatabaseType): SelectLimitStyle {
  return databaseType ? (SELECT_LIMIT_STYLE_BY_DATABASE[databaseType] ?? "limit") : "limit";
}

/**
 * Build a dialect-aware `SELECT * FROM <table>` with a row limit.
 * `table` is inserted as-is (caller supplies quoting / `${table}` token).
 */
export function buildSelectStarWithLimitSql(table: string, limit: number, databaseType?: DatabaseType): string {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SELECT_ROW_LIMIT;
  const style = selectLimitStyleForDatabase(databaseType);
  switch (style) {
    case "top":
      return `SELECT TOP ${safeLimit} *\nFROM ${table}`;
    case "first":
      return `SELECT FIRST ${safeLimit} *\nFROM ${table}`;
    case "fetch-first":
      return `SELECT *\nFROM ${table}\nFETCH FIRST ${safeLimit} ROWS ONLY`;
    case "rows":
      return `SELECT *\nFROM ${table}\nROWS ${safeLimit}`;
    case "rownum":
      return `SELECT *\nFROM ${table}\nWHERE ROWNUM <= ${safeLimit}`;
    case "limit":
      return `SELECT *\nFROM ${table}\nLIMIT ${safeLimit}`;
  }
}

/**
 * Snippet bodies keep a trailing semicolon for insert-at-cursor UX.
 * An unknown JDBC driver may expose any SQL dialect, so the snippet stays
 * unbounded instead of guessing LIMIT; quick actions remain bounded via
 * `buildSelectStarWithLimitSql` regardless.
 */
export function buildSelectSnippetBody(databaseType?: DatabaseType, limit = DEFAULT_SELECT_ROW_LIMIT): string {
  if (databaseType === "jdbc") return "SELECT *\nFROM table;";
  return `${buildSelectStarWithLimitSql("table", limit, databaseType)};`;
}
