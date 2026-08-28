import type { DatabaseType } from "@/types/database";

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

export interface CanFetchNextDataGridSegmentOptions {
  hasMore?: boolean;
  loadedRowCount: number;
  pageSize: number;
  totalRowCount?: number;
  allRowsLoaded?: boolean;
}

export type DataGridInexactTotalRowCountMode = "at-least" | "estimated";

export function dataGridTruncationHintKey(databaseType?: DatabaseType): "grid.truncatedHint" | "grid.victoriaMetricsTruncatedHint" {
  return databaseType === "victoriametrics" ? "grid.victoriaMetricsTruncatedHint" : "grid.truncatedHint";
}

export function dataGridTotalRowCountLabelKey(totalRowCountIsExact: boolean, inexactMode: DataGridInexactTotalRowCountMode): "grid.totalRowCount" | "grid.totalRowCountAtLeast" | "grid.totalRowCountEstimated" {
  if (totalRowCountIsExact) return "grid.totalRowCount";
  return inexactMode === "estimated" ? "grid.totalRowCountEstimated" : "grid.totalRowCountAtLeast";
}

export function showDataGridRerunTotalCountAction(options: { canCalculateTotalRowCount: boolean; displayedTotalRowCount?: number; totalRowCountIsExact: boolean }): boolean {
  if (!options.canCalculateTotalRowCount || options.totalRowCountIsExact !== true) return false;
  return typeof options.displayedTotalRowCount === "number" && Number.isFinite(options.displayedTotalRowCount) && options.displayedTotalRowCount >= 0;
}

export function resolveDataGridPaginationTotal(options: { paginationTotalRowCount?: number; serverKnownTotalRowCount?: number; totalRowCountIsExact: boolean; maxRows?: number }): number | undefined {
  const total = options.paginationTotalRowCount ?? (options.totalRowCountIsExact ? options.serverKnownTotalRowCount : undefined);
  if (total === undefined || options.maxRows === undefined) return total;
  return Math.min(total, options.maxRows);
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

export function canFetchNextDataGridSegment(options: CanFetchNextDataGridSegmentOptions): boolean {
  if (options.hasMore === true) return true;

  const totalRowCount = options.totalRowCount;
  if (typeof totalRowCount === "number" && Number.isFinite(totalRowCount) && totalRowCount >= 0) {
    return options.loadedRowCount < totalRowCount;
  }

  if (options.allRowsLoaded === true) return false;
  return options.loadedRowCount >= Math.max(1, options.pageSize);
}
