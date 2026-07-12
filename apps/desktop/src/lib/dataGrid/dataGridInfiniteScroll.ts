export interface DataGridScrollPosition {
  top: number;
  left: number;
}

export interface DataGridScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function dataGridScrollPosition(top: number, left: number): DataGridScrollPosition {
  return {
    top: Math.max(0, top),
    left: Math.max(0, left),
  };
}

export function shouldCheckInfiniteScrollAfterScroll(previous: DataGridScrollPosition | undefined, current: DataGridScrollPosition): boolean {
  if (!previous) return false;
  // Shift+wheel horizontal scrolling changes scrollLeft only and must not paginate.
  return previous.top !== current.top;
}

export function isDataGridNearScrollBottom(metrics: DataGridScrollMetrics, threshold = 100): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

export function isDataGridAtScrollBottom(metrics: DataGridScrollMetrics, tolerance = 1): boolean {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return maxScrollTop - metrics.scrollTop <= tolerance;
}

export function dataGridBottomScrollTop(metrics: Pick<DataGridScrollMetrics, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
