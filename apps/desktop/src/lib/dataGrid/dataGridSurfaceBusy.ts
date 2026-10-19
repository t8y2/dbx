/** Which in-flight operations put the whole grid surface behind the busy overlay.
 *
 *  A manual total-row count (the button next to the row total in the status bar)
 *  is a background COUNT(*): it never reloads the visible rows, so it must not
 *  mask the grid — users kept reading it as a full table refresh and could not
 *  select or copy while it ran (issue #12652). The count that precedes a jump
 *  to the last page keeps the mask because that flow really does replace the
 *  visible page. */
export interface DataGridSurfaceBusyFlags {
  /** Explicit data reload through the refresh path. */
  isRefreshingData: boolean;
  /** Parent-driven loading (for example the query result still streaming in). */
  loading: boolean;
  /** COUNT that runs before a jump to the last page. */
  lastPageCountLoading: boolean;
  /** Multi-request page jump already walking towards its target page. */
  pageJumpBusy: boolean;
  /** Row preparation (large result assembly) currently in progress. */
  rowPreparationActive: boolean;
}

export function isDataGridSurfaceBusy(flags: DataGridSurfaceBusyFlags): boolean {
  return flags.isRefreshingData || flags.loading || flags.lastPageCountLoading || flags.pageJumpBusy || flags.rowPreparationActive;
}
