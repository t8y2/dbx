import type { QueryResult } from "@/types/database";

export const TABLE_DATA_RESULT_MAX_BYTES = 32 * 1024 * 1024;

export function largeValueCellKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

export function largeValueCellMap(result: Pick<QueryResult, "large_value_cells">): Map<string, NonNullable<QueryResult["large_value_cells"]>[number]> {
  return new Map((result.large_value_cells ?? []).map((cell) => [largeValueCellKey(cell.row_index, cell.column_index), cell]));
}

export function appendLargeValueCells(previous: QueryResult["large_value_cells"], segment: QueryResult["large_value_cells"], rowOffset: number, appendedRowCount: number): QueryResult["large_value_cells"] {
  const appended = (segment ?? []).filter((cell) => cell.row_index < appendedRowCount).map((cell) => ({ ...cell, row_index: cell.row_index + rowOffset }));
  const combined = [...(previous ?? []), ...appended];
  return combined.length > 0 ? combined : undefined;
}

export function remapLargeValueCells(cells: QueryResult["large_value_cells"], rowIndexes: number[]): QueryResult["large_value_cells"] {
  if (!cells?.length) return undefined;
  const targetBySource = new Map(rowIndexes.map((sourceIndex, targetIndex) => [sourceIndex, targetIndex]));
  const remapped = cells
    .map((cell) => {
      const rowIndex = targetBySource.get(cell.row_index);
      return rowIndex === undefined ? undefined : { ...cell, row_index: rowIndex };
    })
    .filter((cell): cell is NonNullable<typeof cell> => !!cell);
  return remapped.length > 0 ? remapped : undefined;
}
