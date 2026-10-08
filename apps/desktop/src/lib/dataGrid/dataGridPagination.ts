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

export interface DataGridLoadAllSegment {
  offset: number;
  limit: number;
}

export type DataGridInexactTotalRowCountMode = "at-least" | "estimated";

export const ELASTICSEARCH_PAGE_JUMP_WARNING_REQUESTS = 100;

export function elasticsearchCursorPageJumpRequestCount(currentPage: number, targetPage: number): number {
  if (!Number.isSafeInteger(currentPage) || !Number.isSafeInteger(targetPage) || currentPage < 1 || targetPage < 1 || currentPage === targetPage) {
    return 0;
  }
  if (targetPage > currentPage) {
    return targetPage - currentPage;
  }

  // search_after only moves forward. The current workaround rebuilds the
  // cursor from page 1 when navigating backward, including the target request.
  return targetPage;
}

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

export interface ReconcileDataGridExactTotalOptions {
  offset: number;
  rowCount: number;
  exactTotal: number;
}

/**
 * Total to display after a page landed with rows beyond the exact counted
 * total, or `undefined` when the counted total still describes the page.
 *
 * The COUNT that produced the exact total and the query that served the page
 * are two separate snapshots: rows can land between them (a table being
 * written to), and an agent result session serves the snapshot it was opened
 * with even after newer rows were counted. Rendering that page against the
 * stale total shows row indexes past the claimed end of the result (#10968) —
 * adopt the observed extent instead, so the displayed total always covers
 * every row the grid actually shows.
 */
export function reconcileDataGridExactTotalWithObservedPage(options: ReconcileDataGridExactTotalOptions): number | undefined {
  const { offset, rowCount, exactTotal } = options;
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) return undefined;
  if (!Number.isSafeInteger(exactTotal) || exactTotal < 0) return undefined;
  const observedExtent = offset + rowCount;
  if (observedExtent <= exactTotal) return undefined;
  return observedExtent;
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

/**
 * Page that the SQL shown under the grid describes. `executedPage*` is the
 * segment that actually ran — it can be the whole remaining table after
 * "load all" — while `page*` intentionally stays on the logical first page of
 * the displayed result, so it cannot describe an extended result on its own.
 */
export function dataGridUserFacingPage(options: { executedPageLimit?: number; executedPageOffset?: number; pageLimit?: number; pageOffset?: number; fallbackLimit: number; fallbackOffset: number }): { limit: number; offset: number } {
  return {
    limit: options.executedPageLimit ?? options.pageLimit ?? options.fallbackLimit,
    offset: options.executedPageOffset ?? options.pageOffset ?? options.fallbackOffset,
  };
}

export function dataGridLoadAllSegment(loadedRowCount: number, maxRows: number, canFetchMore: boolean): DataGridLoadAllSegment | null {
  const offset = Number.isFinite(loadedRowCount) ? Math.max(0, Math.trunc(loadedRowCount)) : 0;
  const boundedMaxRows = Number.isFinite(maxRows) ? Math.max(0, Math.trunc(maxRows)) : 0;
  if (!canFetchMore || offset >= boundedMaxRows) return null;
  return { offset, limit: boundedMaxRows - offset };
}

/**
 * Target cumulative row count for the initial chunk of an explicit "load all"
 * run. Each chunk is bounded by `chunkLimit` (the per-request result-row cap,
 * e.g. 100,000), but an existing dataset that has already reached or exceeded
 * `chunkLimit` must still be able to start loading subsequent chunks up to
 * `totalRowCount` (if known) or by another chunk increment (#10752).
 */
export function dataGridLoadAllInitialTarget(loadedRowCount: number, chunkLimit: number, totalRowCount?: number): number {
  const loaded = Number.isFinite(loadedRowCount) ? Math.max(0, Math.trunc(loadedRowCount)) : 0;
  const chunk = Number.isFinite(chunkLimit) ? Math.max(1, Math.trunc(chunkLimit)) : 1;
  const chunkCap = loaded < chunk ? chunk : loaded + chunk;
  const total = typeof totalRowCount === "number" && Number.isFinite(totalRowCount) && totalRowCount >= 0 ? Math.trunc(totalRowCount) : undefined;
  return total !== undefined ? Math.min(chunkCap, total) : chunkCap;
}

/**
 * Next chunk of an explicit "load all" run, issued after the previous chunk
 * completed. The per-request result-row cap bounds each request, not the run:
 * the button promises every remaining row (the confirm dialog quotes the real
 * remaining count), so stopping at the cap left tables half-loaded (#10752).
 * The run ends only when the server returns fewer rows than requested, when a
 * known total has been reached, or when a chunk appends nothing (loop guard).
 */
export function dataGridLoadAllNextSegment(options: { loadedRowCount: number; requestedOffset: number; requestedLimit: number; totalRowCount?: number }): DataGridLoadAllSegment | null {
  const loadedRowCount = Number.isFinite(options.loadedRowCount) ? Math.max(0, Math.trunc(options.loadedRowCount)) : 0;
  const requestedLimit = Number.isFinite(options.requestedLimit) ? Math.max(0, Math.trunc(options.requestedLimit)) : 0;
  if (requestedLimit <= 0) return null;
  const appendedRows = loadedRowCount - Math.max(0, Math.trunc(options.requestedOffset));
  if (appendedRows < requestedLimit) return null;
  const totalRowCount = typeof options.totalRowCount === "number" && Number.isFinite(options.totalRowCount) && options.totalRowCount >= 0 ? Math.trunc(options.totalRowCount) : undefined;
  if (totalRowCount !== undefined && loadedRowCount >= totalRowCount) return null;
  return { offset: loadedRowCount, limit: totalRowCount !== undefined ? Math.min(requestedLimit, totalRowCount - loadedRowCount) : requestedLimit };
}
