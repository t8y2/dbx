export interface PartialLoadCopyInfo {
  loadedRows: number;
  /** Server-known total row count, or null when unknown. */
  totalRows: number | null;
  /** The backend reported more rows after the loaded ones. */
  hasMore: boolean;
}

/** True when a copy from this grid cannot cover the whole result set. */
export function isPartiallyLoadedCopy(info: PartialLoadCopyInfo): boolean {
  if (info.loadedRows <= 0) return false;
  if (info.hasMore) return true;
  return info.totalRows !== null && info.totalRows > info.loadedRows;
}

export function partialLoadCopyHintKey(info: PartialLoadCopyInfo): string {
  return info.totalRows !== null ? "grid.copyPartialRowsHintWithTotal" : "grid.copyPartialRowsHint";
}

/**
 * True when this copy took every loaded row of the result set, so the
 * "copied the {loaded} loaded rows" hint describes it (#15602).
 *
 * `loadedRows` counts the rows the grid holds, which is not what a
 * selection-scoped copy puts on the clipboard: copying two checked rows, a
 * cell range, or one right-clicked cell out of a partially loaded 100-row
 * result must not claim that 100 rows were copied.
 */
export function coversAllLoadedRows(info: PartialLoadCopyInfo, copiedRows: number): boolean {
  return info.loadedRows > 0 && copiedRows >= info.loadedRows;
}
