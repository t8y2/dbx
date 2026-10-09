import type { QueryResult } from "@/types/database";
import type { SnapshotExportRequest } from "@/lib/backend/http";

interface SnapshotExportRow {
  sourceIndex?: number;
  data: unknown[];
  isNew?: boolean;
  isDirtyCol?: boolean[];
}

/** Projection uses source positions, never labels, so quoted and repeated names remain distinct. */
export function snapshotExportSelection(
  result: QueryResult,
  columns: string[],
  sourceColumns: number[],
  items: SnapshotExportRow[],
): Pick<SnapshotExportRequest, "columns" | "rows" | "cells" | "context"> | undefined {
  const refs = new Map((result.large_value_cells ?? []).filter((cell) => cell.value_ref).map((cell) => [`${cell.row_index}:${cell.column_index}`, cell.value_ref!]));
  const cells: SnapshotExportRequest["cells"] = [];
  items.forEach((item, rowIndex) => {
    if (item.isNew || item.sourceIndex === undefined) return;
    sourceColumns.forEach((sourceColumn, columnIndex) => {
      if (item.isDirtyCol?.[columnIndex]) return;
      const valueRef = refs.get(`${item.sourceIndex}:${sourceColumn}`);
      if (valueRef) cells.push({ rowIndex, columnIndex, valueRef });
    });
  });
  if (!cells.length) return undefined;
  if (!result.large_value_context) throw new Error("LOB result connection is unavailable; execute the query again");
  return { columns, rows: items.map((item) => item.data), cells, context: { ...result.large_value_context, valueRef: "" } };
}

export function assertSnapshotXlsxCellLengths(rows: unknown[][]): void {
  for (const row of rows) for (const value of row) {
    if (typeof value !== "string") continue;
    let count = 0;
    for (const _character of value) if (++count > 32767) {
      throw new Error("XLSX cannot preserve a LOB longer than 32,767 characters; use CSV/JSON or download the complete value");
    }
  }
}
