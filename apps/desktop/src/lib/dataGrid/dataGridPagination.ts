export interface CanGoNextDataGridPageOptions {
  hasMore?: boolean;
  rowCount: number;
  pageSize: number;
  pageOffset?: number;
  currentPage?: number;
  totalRowCount?: number;
  // True when every result row is already in memory (SQL editor result with no
  // server-side pagination). rowCount IS the authoritative total in that case,
  // so a full final page must not appear as "more available".
  allRowsLoaded?: boolean;
}

export interface CompleteLocalDataGridResultOptions {
  isResultsContext: boolean;
  rowCount: number;
  pageLimit?: number;
  pageOffset?: number;
  totalRowCount?: number;
  truncated?: boolean;
  hasMore?: boolean;
}

export function hasCompleteLocalDataGridResult(options: CompleteLocalDataGridResultOptions): boolean {
  if (!options.isResultsContext || options.truncated === true || options.hasMore === true) return false;
  if (options.pageLimit === undefined) return true;
  if ((options.pageOffset ?? 0) !== 0) return false;

  const pageLimit = Math.max(1, options.pageLimit);
  if (options.rowCount < pageLimit) return true;

  const totalRowCount = options.totalRowCount;
  return typeof totalRowCount === "number" && Number.isFinite(totalRowCount) && totalRowCount >= 0 && options.rowCount >= totalRowCount;
}

export function canGoNextDataGridPage(options: CanGoNextDataGridPageOptions): boolean {
  if (options.hasMore === true) return true;

  const pageSize = Math.max(1, options.pageSize);
  const currentOffset = typeof options.pageOffset === "number" && options.pageOffset >= 0 ? options.pageOffset : Math.max(0, (options.currentPage ?? 1) - 1) * pageSize;

  const totalRowCount = options.totalRowCount;
  if (typeof totalRowCount === "number" && Number.isFinite(totalRowCount) && totalRowCount >= 0) {
    return currentOffset + pageSize < totalRowCount;
  }

  if (options.allRowsLoaded === true) {
    return currentOffset + pageSize < options.rowCount;
  }

  return options.rowCount >= pageSize;
}
