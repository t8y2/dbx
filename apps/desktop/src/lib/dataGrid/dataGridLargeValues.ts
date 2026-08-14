import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export const TABLE_DATA_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const TABLE_DATA_CELL_PREVIEW_MIN_SIZE = 1;
export const TABLE_DATA_CELL_PREVIEW_SIZE = 8 * 1024;
export const TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES = 24 * 1024 * 1024;
export const TABLE_DATA_TEXT_SERIALIZED_BYTES_PER_CHARACTER = 6;
const TABLE_DATA_LARGE_VALUE_MARKER_PREFIX = "__DBX_LARGE_VALUE_BYTES_";

function normalizedDataTypeBase(dataType: string): string {
  return dataType.trim().split(/[([]/, 1)[0]?.trim().toLocaleLowerCase() ?? "";
}

function declaredDataTypeLength(dataType: string): number | undefined {
  const match = dataType.match(/\(\s*(\d+)/);
  if (!match?.[1]) return undefined;
  const length = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(length) ? length : undefined;
}

function mysqlColumnNeedsLargeValuePreview(column: ColumnInfo, previewSize: number): boolean {
  const base = normalizedDataTypeBase(column.data_type);
  if (matchesMysqlUnboundedLargeValueType(base)) return true;
  if (base !== "varchar" && base !== "varbinary") return false;
  return (declaredDataTypeLength(column.data_type) ?? 0) > previewSize;
}

function previewSizeForColumnCount(pageSize: number | undefined, previewColumnCount: number): number {
  const budgetedSize = Math.floor(TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES / Math.max(1, pageSize ?? 1) / previewColumnCount / TABLE_DATA_TEXT_SERIALIZED_BYTES_PER_CHARACTER);
  return Math.max(TABLE_DATA_CELL_PREVIEW_MIN_SIZE, Math.min(TABLE_DATA_CELL_PREVIEW_SIZE, budgetedSize));
}

function mysqlPreviewBudget(columns: readonly ColumnInfo[], keyColumns: ReadonlySet<string>, pageSize: number | undefined): { previewColumnCount: number; previewSize: number } | null {
  let previewColumnCount = 1;
  let previewSize = previewSizeForColumnCount(pageSize, previewColumnCount);
  for (;;) {
    const nextCount = columns.filter((column) => !keyColumns.has(column.name.toLocaleLowerCase()) && mysqlColumnNeedsLargeValuePreview(column, previewSize)).length;
    if (nextCount === 0) return null;
    const nextSize = previewSizeForColumnCount(pageSize, nextCount);
    if (nextCount === previewColumnCount && nextSize === previewSize) return { previewColumnCount: nextCount, previewSize: nextSize };
    previewColumnCount = nextCount;
    previewSize = nextSize;
  }
}

function matchesMysqlUnboundedLargeValueType(base: string): boolean {
  return base === "blob" || base === "mediumblob" || base === "longblob" || base === "text" || base === "mediumtext" || base === "longtext" || base === "json";
}

export function canUseTableDataLargeValuePreview(databaseType: DatabaseType | undefined, columns: readonly ColumnInfo[], primaryKeys: readonly string[]): boolean {
  return (databaseType === "mysql" || databaseType === "postgres") && columns.length > 0 && primaryKeys.length > 0 && !columns.some((column) => column.name.toLocaleUpperCase().startsWith(TABLE_DATA_LARGE_VALUE_MARKER_PREFIX));
}

export function tableDataLargeValuePreviewOptions(databaseType: DatabaseType | undefined, columns: readonly ColumnInfo[], primaryKeys: readonly string[], pageSize?: number): { columnTypes: string[]; largeValuePreviewSize: number } | Record<string, never> {
  if (!canUseTableDataLargeValuePreview(databaseType, columns, primaryKeys)) return {};
  const keyColumns = new Set(primaryKeys.map((column) => column.toLocaleLowerCase()));
  const mysqlBudget = databaseType === "mysql" ? mysqlPreviewBudget(columns, keyColumns, pageSize) : null;
  const previewColumnCount = databaseType === "mysql" ? (mysqlBudget?.previewColumnCount ?? 0) : columns.filter((column) => !keyColumns.has(column.name.toLocaleLowerCase())).length;
  if (previewColumnCount === 0) return {};
  return {
    columnTypes: columns.map((column) => column.data_type),
    largeValuePreviewSize: mysqlBudget?.previewSize ?? previewSizeForColumnCount(pageSize, previewColumnCount),
  };
}

export function largeValueCellKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

export function largeValueCellMap(result: Pick<QueryResult, "large_value_cells">): Map<string, NonNullable<QueryResult["large_value_cells"]>[number]> {
  return new Map((result.large_value_cells ?? []).map((cell) => [largeValueCellKey(cell.row_index, cell.column_index), cell]));
}

export function createResultScopedPendingRequests<T>() {
  const pending = new Map<string, { result: object; promise: Promise<T> }>();

  return {
    run(key: string, result: object, request: () => Promise<T>): Promise<T> {
      const current = pending.get(key);
      if (current?.result === result) return current.promise;

      let entry: { result: object; promise: Promise<T> };
      const promise = Promise.resolve()
        .then(request)
        .finally(() => {
          if (pending.get(key) === entry) pending.delete(key);
        });
      entry = { result, promise };
      pending.set(key, entry);
      return promise;
    },
  };
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
