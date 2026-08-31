import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";
import type { CellValue } from "@/lib/dataGrid/cellValue";

export const TABLE_DATA_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const TABLE_DATA_CELL_PREVIEW_MIN_SIZE = 1;
export const TABLE_DATA_CELL_PREVIEW_SIZE = 8 * 1024;
export const TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES = 24 * 1024 * 1024;
export const TABLE_DATA_TEXT_SERIALIZED_BYTES_PER_CHARACTER = 6;
export const TABLE_DATA_VISIBLE_PREVIEW_SIZE = 512;
export const TABLE_DATA_VISIBLE_PREVIEW_MAX_ROWS = 100;
export const TABLE_DATA_VISIBLE_PREVIEW_CACHE_ROWS = 2_000;
export const TABLE_DATA_VISIBLE_PREVIEW_CACHE_CONTENT_MAX_BYTES = 16 * 1024 * 1024;
const TABLE_DATA_LARGE_VALUE_MARKER_PREFIX = "__DBX_LARGE_VALUE_BYTES_";

export interface TableDataVisiblePreviewRowRange {
  start: number;
  end: number;
}

export interface ResultScopedRowCache<T> {
  has(rowIndex: number, columnIndex: number): boolean;
  get(rowIndex: number, columnIndex: number): T | undefined;
  touch(rowIndex: number): void;
  remember(rowIndex: number, columnIndex: number, value: T): void;
  forget(rowIndex: number, columnIndex: number): void;
  evict(protectedRows?: ReadonlySet<number>): Array<{ rowIndex: number; columnIndex: number; value: T }>;
}

export function tableDataVisiblePreviewRowRange(scrollTop: number, viewportHeight: number, rowHeight: number, rowCount: number, maxRows = TABLE_DATA_VISIBLE_PREVIEW_MAX_ROWS): TableDataVisiblePreviewRowRange | null {
  if (rowHeight <= 0 || rowCount <= 0 || maxRows <= 0) return null;
  const firstVisible = Math.max(0, Math.min(rowCount - 1, Math.floor(Math.max(0, scrollTop) / rowHeight)));
  const visibleRows = Math.max(1, Math.ceil(Math.max(rowHeight, viewportHeight) / rowHeight));
  const targetRows = Math.min(rowCount, maxRows, visibleRows * 3);
  const rowsBefore = Math.floor(Math.max(0, targetRows - visibleRows) / 2);
  let start = Math.max(0, firstVisible - rowsBefore);
  const end = Math.min(rowCount, start + targetRows);
  start = Math.max(0, end - targetRows);
  return { start, end };
}

export function tableDataVisiblePreviewContentBytes(value: CellValue): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  return 0;
}

export function createResultScopedRowCache<T>(maxRows: number, options: { maxBytes?: number; sizeOf?: (value: T) => number } = {}): ResultScopedRowCache<T> {
  const rows = new Map<number, Map<number, T>>();
  const rowBytes = new Map<number, number>();
  const maxCachedRows = Math.max(0, maxRows);
  const maxCachedBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
  const sizeOf = options.sizeOf ?? (() => 0);
  let cachedBytes = 0;

  function touch(rowIndex: number, values: Map<number, T>) {
    rows.delete(rowIndex);
    rows.set(rowIndex, values);
  }

  function removeRow(rowIndex: number, values: Map<number, T>, evicted: Array<{ rowIndex: number; columnIndex: number; value: T }>) {
    rows.delete(rowIndex);
    cachedBytes = Math.max(0, cachedBytes - (rowBytes.get(rowIndex) ?? 0));
    rowBytes.delete(rowIndex);
    for (const [columnIndex, value] of values) evicted.push({ rowIndex, columnIndex, value });
  }

  function exceedsLimit(): boolean {
    return rows.size > maxCachedRows || cachedBytes > maxCachedBytes;
  }

  return {
    has(rowIndex, columnIndex) {
      return rows.get(rowIndex)?.has(columnIndex) ?? false;
    },
    get(rowIndex, columnIndex) {
      return rows.get(rowIndex)?.get(columnIndex);
    },
    touch(rowIndex) {
      const values = rows.get(rowIndex);
      if (values) touch(rowIndex, values);
    },
    remember(rowIndex, columnIndex, value) {
      const values = rows.get(rowIndex) ?? new Map<number, T>();
      if (!values.has(columnIndex)) {
        values.set(columnIndex, value);
        const valueBytes = Math.max(0, sizeOf(value));
        cachedBytes += valueBytes;
        rowBytes.set(rowIndex, (rowBytes.get(rowIndex) ?? 0) + valueBytes);
      }
      touch(rowIndex, values);
    },
    forget(rowIndex, columnIndex) {
      const values = rows.get(rowIndex);
      if (!values) return;
      const value = values.get(columnIndex);
      if (value === undefined && !values.has(columnIndex)) return;
      values.delete(columnIndex);
      const valueBytes = Math.max(0, sizeOf(value as T));
      cachedBytes = Math.max(0, cachedBytes - valueBytes);
      const remainingRowBytes = Math.max(0, (rowBytes.get(rowIndex) ?? 0) - valueBytes);
      if (values.size === 0) {
        rows.delete(rowIndex);
        rowBytes.delete(rowIndex);
      } else {
        rowBytes.set(rowIndex, remainingRowBytes);
      }
    },
    evict(protectedRows = new Set<number>()) {
      const evicted: Array<{ rowIndex: number; columnIndex: number; value: T }> = [];
      for (const [rowIndex, values] of rows) {
        if (!exceedsLimit()) break;
        if (protectedRows.has(rowIndex)) continue;
        removeRow(rowIndex, values, evicted);
      }
      for (const [rowIndex, values] of rows) {
        if (!exceedsLimit()) break;
        removeRow(rowIndex, values, evicted);
      }
      return evicted;
    },
  };
}

function normalizedDataTypeBase(dataType: string): string {
  return dataType.trim().split(/[([]/, 1)[0]?.trim().toLocaleLowerCase() ?? "";
}

export function isTableDataVisiblePreviewColumn(databaseType: DatabaseType | undefined, dataType: string): boolean {
  const normalized = dataType.trim().toLocaleLowerCase();
  const base = normalizedDataTypeBase(dataType);
  if (databaseType === "mysql") {
    return base === "text" || base === "tinytext" || base === "mediumtext" || base === "longtext" || base === "varchar" || base === "json";
  }
  if (databaseType === "postgres") {
    return !normalized.includes("[") && (base === "char" || base === "character" || base === "varchar" || base === "text" || base === "citext" || base === "name" || base === "xml" || base === "json" || base === "jsonb" || base === "tsvector" || normalized.startsWith("character varying"));
  }
  return false;
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
