import type { DatabaseType } from "../types/database.ts";
import { quoteTableIdentifier } from "./tableSelectSql.ts";
import { findStatementAtCursor } from "./sqlStatementSplit.ts";

export type QuerySortDirection = "asc" | "desc";

export interface SortedQuerySqlResult {
  ok: true;
  sql: string;
}

export interface SortedQuerySqlError {
  ok: false;
  reason: "empty" | "multi" | "not_select" | "with";
}

export function buildSortedQuerySql(
  originalSql: string,
  databaseType: DatabaseType | undefined,
  column: string,
  direction: QuerySortDirection,
): SortedQuerySqlResult | SortedQuerySqlError {
  const baseSql = originalSql.trim();
  if (!baseSql) return { ok: false, reason: "empty" };

  const statement = findStatementAtCursor(baseSql, 0)
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (!statement) return { ok: false, reason: "empty" };
  if (statement.length !== baseSql.replace(/;+\s*$/, "").trim().length) {
    return { ok: false, reason: "multi" };
  }
  if (/^\s*WITH\b/i.test(statement)) {
    return { ok: false, reason: "with" };
  }
  if (!/^\s*SELECT\b/i.test(statement)) {
    return { ok: false, reason: "not_select" };
  }

  const quotedColumn = quoteTableIdentifier(databaseType, column);
  return {
    ok: true,
    sql: `SELECT * FROM (${statement}) t ORDER BY ${quotedColumn} ${direction.toUpperCase()};`,
  };
}
