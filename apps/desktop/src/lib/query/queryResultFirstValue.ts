import type { QueryResult } from "@/types/database";

export interface ResultFirstCellValue {
  /** Header label of the column the value was read from. */
  column: string;
  /** Cell text; null renders as an empty string, matching grid copy behavior. */
  value: string;
}

/**
 * Column `column` (1-based) of the first row of a query result — the read
 * several surfaces do inline as `rows[0]?.[n]`. Returns null when there is no
 * result, no first row, or no such column, so shortcut-style callers can
 * decline their key and leave it free for other bindings.
 */
export function firstResultCellValue(result: Pick<QueryResult, "columns" | "rows"> | null | undefined, column: number): ResultFirstCellValue | null {
  if (!result || column < 1) return null;
  const firstRow = result.rows?.[0];
  if (!firstRow || firstRow.length < column) return null;
  const cell = firstRow[column - 1];
  return { column: result.columns?.[column - 1] ?? String(column), value: cell == null ? "" : String(cell) };
}
