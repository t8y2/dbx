import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export const TABLE_DATA_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const TABLE_DATA_CELL_PREVIEW_MIN_SIZE = 1;
export const TABLE_DATA_CELL_PREVIEW_SIZE = 8 * 1024;
export const TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES = 24 * 1024 * 1024;
export const TABLE_DATA_TEXT_SERIALIZED_BYTES_PER_CHARACTER = 6;
const TABLE_DATA_LARGE_VALUE_MARKER_PREFIX = "__DBX_LARGE_VALUE_BYTES_";

export function canUseTableDataLargeValuePreview(databaseType: DatabaseType | undefined, columns: readonly ColumnInfo[], primaryKeys: readonly string[]): boolean {
  return (databaseType === "mysql" || databaseType === "postgres") && columns.length > 0 && primaryKeys.length > 0 && !columns.some((column) => column.name.toLocaleUpperCase().startsWith(TABLE_DATA_LARGE_VALUE_MARKER_PREFIX));
}

export function tableDataLargeValuePreviewOptions(databaseType: DatabaseType | undefined, columns: readonly ColumnInfo[], primaryKeys: readonly string[], pageSize?: number): { columnTypes: string[]; largeValuePreviewSize: number } | Record<string, never> {
  if (!canUseTableDataLargeValuePreview(databaseType, columns, primaryKeys)) return {};
  const keyColumns = new Set(primaryKeys.map((column) => column.toLocaleLowerCase()));
  const previewColumnCount = columns.filter((column) => !keyColumns.has(column.name.toLocaleLowerCase())).length;
  if (previewColumnCount === 0) return {};
  const budgetedSize = Math.floor(TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES / Math.max(1, pageSize ?? 1) / previewColumnCount / TABLE_DATA_TEXT_SERIALIZED_BYTES_PER_CHARACTER);
  return {
    columnTypes: columns.map((column) => column.data_type),
    largeValuePreviewSize: Math.max(TABLE_DATA_CELL_PREVIEW_MIN_SIZE, Math.min(TABLE_DATA_CELL_PREVIEW_SIZE, budgetedSize)),
  };
}

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
