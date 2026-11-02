export interface DataGridScrollPosition {
  top: number;
  left: number;
}

export interface DataGridScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface DataGridAppendResult {
  rows: readonly unknown[];
  appended_from_row_count?: number;
  session_id?: string | null;
  has_more?: boolean;
}

export interface DataGridInfiniteScrollAppendCompletion {
  loadedPage: number;
  allLoaded: boolean;
}

export function dataGridScrollPosition(top: number, left: number): DataGridScrollPosition {
  return {
    top: Math.max(0, top),
    left: Math.max(0, left),
  };
}

export function restoredDataGridScrollLeft(scrollLeft: number, scrollWidth: number, clientWidth: number): number {
  return Math.max(0, Math.min(Math.max(0, scrollWidth - clientWidth), scrollLeft));
}

export function shouldCheckInfiniteScrollAfterScroll(previous: DataGridScrollPosition | undefined, current: DataGridScrollPosition): boolean {
  if (!previous) return false;
  // Shift+wheel horizontal scrolling changes scrollLeft only and must not paginate.
  return previous.top !== current.top;
}

export function isDataGridNearScrollBottom(metrics: DataGridScrollMetrics, threshold = 100): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

export function isDataGridPrefixAppend(previous: DataGridAppendResult | undefined, next: DataGridAppendResult): boolean {
  if (!previous || next.appended_from_row_count !== previous.rows.length || next.rows.length < previous.rows.length) return false;
  return previous.rows.every((row, index) => row === next.rows[index]);
}

export function dataGridInfiniteScrollAppendCompletion(previous: DataGridAppendResult | undefined, next: DataGridAppendResult, options: { pageSize: number; maxRows: number; loadAll?: { requestedLimit: number; totalRowCount?: number } }): DataGridInfiniteScrollAppendCompletion | undefined {
  if (!isDataGridPrefixAppend(previous, next)) return undefined;

  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const maxRows = Math.max(1, Math.floor(options.maxRows));
  const appendedFromRowCount = next.appended_from_row_count!;
  const appendedRowCount = next.rows.length - appendedFromRowCount;
  const cursorExhausted = !!previous?.session_id && previous.has_more === true && next.has_more === false;

  // An explicit "load all" run keeps appending past the per-request row cap
  // (the run promised every remaining row), so the cap must not be read as the
  // end of data here (#10752). The run is over only when the server returned
  // fewer rows than requested, appended nothing at all, or an exact known
  // total has been reached.
  const loadAll = options.loadAll;
  if (loadAll) {
    const requestedLimit = Math.max(1, Math.floor(loadAll.requestedLimit));
    const totalRowCount = typeof loadAll.totalRowCount === "number" && Number.isFinite(loadAll.totalRowCount) && loadAll.totalRowCount >= 0 ? Math.trunc(loadAll.totalRowCount) : undefined;
    const exhausted = appendedRowCount < requestedLimit || appendedRowCount <= 0 || (totalRowCount !== undefined && next.rows.length >= totalRowCount);
    return {
      loadedPage: Math.max(1, Math.ceil(next.rows.length / pageSize)),
      allLoaded: exhausted,
    };
  }

  const requestedRowCount = Math.min(pageSize, Math.max(0, maxRows - appendedFromRowCount));

  return {
    loadedPage: Math.max(1, Math.ceil(next.rows.length / pageSize)),
    allLoaded: next.rows.length >= maxRows || appendedRowCount < requestedRowCount || cursorExhausted,
  };
}

export function didDataGridInfiniteScrollContextChange(current: readonly string[], previous: readonly string[] | undefined): boolean {
  return !previous || current.length !== previous.length || current.some((value, index) => value !== previous[index]);
}

export function isDataGridAtScrollBottom(metrics: DataGridScrollMetrics, tolerance = 1): boolean {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return maxScrollTop > tolerance && maxScrollTop - metrics.scrollTop <= tolerance;
}

export function dataGridBottomScrollTop(metrics: Pick<DataGridScrollMetrics, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
