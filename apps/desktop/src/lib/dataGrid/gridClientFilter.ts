/**
 * Client-side value filtering for query-result grids (#13237).
 *
 * Table-data grids filter on the server through a WHERE clause; a query
 * result has no table to re-query, so its「筛选此值」menu filters the loaded
 * rows in memory instead. Modes mirror the server-side submenu minus the
 * numeric comparisons and the SQL condition builder.
 *
 * Comparison follows the server-side semantics instead of stringifying cells:
 * NULL stays distinct from empty text, equals/not-equals on a NULL value
 * become IS NULL / IS NOT NULL, and text is never coerced to a number
 * (numeric comparison needs a numeric column type or two numeric cells).
 */

import type { CellValue } from "./cellValue";
import { isNumericColumnType } from "./dataGridColumnType";

export type ResultClientFilterMode = "equals" | "not-equals" | "like" | "not-like" | "less-than" | "greater-than" | "is-null" | "is-not-null";

export interface ResultClientFilter {
  /** Actual (source) column index the filter applies to. */
  colIndex: number;
  mode: ResultClientFilterMode;
  /** Raw cell value for the value modes; null for is-null / is-not-null. */
  value: CellValue;
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Text used by LIKE; callers keep NULL out so it never reads as empty text. */
function filterText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Numeric view of a cell, only for numeric columns or numeric cells. */
function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function valuesEqual(cell: unknown, needle: unknown, columnType: string | undefined): boolean {
  if (isNumericColumnType(columnType)) {
    const a = numericValue(cell);
    const b = numericValue(needle);
    return a !== null && b !== null && a === b;
  }
  // Typed comparison: on a text column "007" is not 7 and "1.0" is not 1.
  return cell === needle;
}

/** Ordering for less-than / greater-than; null means incomparable. */
function compareValues(cell: unknown, needle: unknown, columnType: string | undefined): number | null {
  if (isNumericColumnType(columnType)) {
    const a = numericValue(cell);
    const b = numericValue(needle);
    return a === null || b === null ? null : Math.sign(a - b);
  }
  if (typeof cell === "number" && typeof needle === "number") return Math.sign(cell - needle);
  // Text keeps its collation order; it is never parsed as a number (#13419).
  if (typeof cell === "string" && typeof needle === "string") return Math.sign(cell.localeCompare(needle));
  return null;
}

export function matchesResultClientFilter(row: readonly CellValue[], filter: ResultClientFilter, columnType?: string): boolean {
  const cell = row[filter.colIndex];
  const cellIsNull = isNullish(cell);
  switch (filter.mode) {
    case "is-null":
      return cellIsNull;
    case "is-not-null":
      return !cellIsNull;
  }

  const needle = filter.value;
  const needleIsNull = isNullish(needle);
  switch (filter.mode) {
    case "equals":
      // A NULL cell filters to IS NULL, so empty-text rows stay out (#13419).
      if (needleIsNull) return cellIsNull;
      return !cellIsNull && valuesEqual(cell, needle, columnType);
    case "not-equals":
      if (needleIsNull) return !cellIsNull;
      // SQL three-valued logic: `col <> value` never matches a NULL row.
      return !cellIsNull && !valuesEqual(cell, needle, columnType);
    case "like":
    case "not-like": {
      // LIKE against NULL is unknown in SQL, so neither side matches.
      if (cellIsNull || needleIsNull) return false;
      const text = filterText(cell).toLowerCase();
      const pattern = filterText(needle).toLowerCase();
      return filter.mode === "like" ? text.includes(pattern) : !text.includes(pattern);
    }
    case "less-than":
    case "greater-than": {
      if (cellIsNull || needleIsNull) return false;
      const compared = compareValues(cell, needle, columnType);
      if (compared === null) return false;
      return filter.mode === "less-than" ? compared < 0 : compared > 0;
    }
  }
}
