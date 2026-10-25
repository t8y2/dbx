/**
 * Client-side value filtering for query-result grids (#13237).
 *
 * Table-data grids filter on the server through a WHERE clause; a query
 * result has no table to re-query, so its「筛选此值」menu filters the loaded
 * rows in memory instead. Modes mirror the server-side submenu minus the
 * numeric comparisons and the SQL condition builder.
 */

export type ResultClientFilterMode = "equals" | "not-equals" | "like" | "not-like" | "less-than" | "greater-than" | "is-null" | "is-not-null";

export interface ResultClientFilter {
  /** Actual (source) column index the filter applies to. */
  colIndex: number;
  mode: ResultClientFilterMode;
  /** Raw cell text for the value modes; empty for is-null / is-not-null. */
  value: string;
}

/** Display text of a cell exactly as the value menu captured it. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

export function matchesResultClientFilter(row: readonly unknown[], filter: ResultClientFilter): boolean {
  const value = row[filter.colIndex];
  switch (filter.mode) {
    case "is-null":
      return value === null || value === undefined || (typeof value === "string" && value === "");
    case "is-not-null":
      return !(value === null || value === undefined || (typeof value === "string" && value === ""));
  }
  const text = cellText(value);
  const needle = filter.value;
  switch (filter.mode) {
    case "equals":
      return text === needle || numericEqual(text, needle);
    case "not-equals":
      return !matchesResultClientFilter(row, { ...filter, mode: "equals" });
    case "like":
      return text.toLowerCase().includes(needle.toLowerCase());
    case "not-like":
      return !text.toLowerCase().includes(needle.toLowerCase());
    case "less-than":
    case "greater-than": {
      // Numeric comparison when both sides parse; non-numeric cell values
      // never match a numeric comparison.
      const cellNumber = Number(text);
      const needleNumber = Number(needle);
      if (text === "" || Number.isNaN(cellNumber) || Number.isNaN(needleNumber)) return false;
      return filter.mode === "less-than" ? cellNumber < needleNumber : cellNumber > needleNumber;
    }
  }
}

function numericEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const a = Number(left);
  const b = Number(right);
  return left !== "" && right !== "" && !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}
