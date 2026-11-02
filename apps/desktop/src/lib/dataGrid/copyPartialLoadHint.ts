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
