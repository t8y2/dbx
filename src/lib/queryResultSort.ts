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
  resultColumns: string[],
  columnIndex: number,
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

  const aliases = buildDerivedColumnAliases(resultColumns);
  const sortAlias = aliases[columnIndex] ?? aliases[resultColumns.indexOf(column)] ?? fallbackAlias(columnIndex);
  const quotedColumn = quoteTableIdentifier(databaseType, sortAlias);
  const aliasList = aliases.map((alias) => quoteTableIdentifier(databaseType, alias)).join(", ");
  return {
    ok: true,
    sql: `SELECT * FROM (${statement}) t(${aliasList}) ORDER BY ${quotedColumn} ${direction.toUpperCase()};`,
  };
}

function buildDerivedColumnAliases(resultColumns: string[]): string[] {
  const seen = new Map<string, number>();
  return resultColumns.map((column, index) => {
    const base = normalizeAliasBase(column, index);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function normalizeAliasBase(column: string, index: number): string {
  const compact = column.trim().replace(/\s+/g, "_");
  const safe = compact.replace(/[^\p{L}\p{N}_$]/gu, "_").replace(/^_+|_+$/g, "");
  return safe || fallbackAlias(index);
}

function fallbackAlias(index: number): string {
  return `column_${index + 1}`;
}
