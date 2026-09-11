import type { DocumentFilterRule } from "@/lib/app/documentStoreProvider";

/**
 * Rows and totals a completed load produced, replayed on remount instead of
 * re-querying. `signature` pins the identity and conditions they were loaded
 * under (store kind, connection/database/collection, filter, sort, page, page
 * size, infinite-scroll mode); a restore that does not match it falls through
 * to a normal load.
 */
export interface DocumentBrowserDataSnapshot {
  signature: string;
  /** DataGrid's logical-result identity, so it may replay scroll and selection. */
  viewGeneration?: string;
  documents: Record<string, unknown>[];
  copyDocuments: Record<string, unknown>[];
  copyDocumentsAvailable: boolean;
  gridColumns: string[];
  gridColumnTypes: string[];
  total?: number;
  totalIsExact: boolean;
  paginationTotal?: number;
  selectedIdx: number | null;
}

export interface DocumentBrowserStateSnapshot {
  /** Manual JSON filter text from the collection filter input. */
  filterInput: string;
  /** Manual JSON sort text from the collection sort input. */
  sortInput: string;
  /** Structured-filter contribution applied on top of the manual filter. */
  appliedDocumentFilter: Record<string, unknown> | null;
  /** Rules backing the structured filter builder. */
  documentFilterRules: DocumentFilterRule[];
  /** Zero-based page position; only meaningful for skip-based stores. */
  page: number;
  /**
   * Rows from the last completed load. Written only by the unmount capture; a
   * conditions-only save (the keystroke path) drops it, which is the whole
   * invalidation story — a dropped payload degrades to today's reload.
   */
  data?: DocumentBrowserDataSnapshot;
}

// ContentArea renders only the active tab, so DocumentBrowser is unmounted on
// every tab switch and remounted when the user comes back. Query conditions and
// the rows they produced survive that round trip through this session-scoped
// cache keyed by tab id — the same role tab.whereInput/tab.orderByInput and
// tab.result play for SQL data tabs, which have no equivalent here. The bounds
// keep state for long tab sessions from accumulating forever.
const MAX_ENTRIES = 32;
/** Payloads larger than this are dropped; the tab reloads instead. */
export const MAX_RESTORED_DOCUMENT_ROWS = 2_000;
/** Only the most recently used tabs keep rows; older ones keep conditions. */
export const MAX_DATA_ENTRIES = 8;

const cache = new Map<string, DocumentBrowserStateSnapshot>();
const gridFsCache = new Map<string, GridFsBrowserStateSnapshot<unknown>>();
const closingKeys = new Set<string>();

/**
 * Clear a tab's cached state and block new writes for a short window, so the
 * `onBeforeUnmount` capture cannot resurrect an entry after the tab is closed.
 * Mirrors `beginClosingDataGridViewSnapshotsForTab`.
 */
export function beginClosingBrowserState(stateKey: string): void {
  closingKeys.add(stateKey);
  // Some test environments stub `window` without timers, so a bare
  // `window.setTimeout` would throw while closing a tab.
  const schedule = typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout.bind(window) : setTimeout;
  schedule(() => closingKeys.delete(stateKey), 5000);
  cache.delete(stateKey);
  gridFsCache.delete(stateKey);
}

function trimDataPayloads(): void {
  const keysNewestFirst = [...cache.keys()].reverse();
  let kept = 0;
  for (const key of keysNewestFirst) {
    const entry = cache.get(key);
    if (!entry?.data) continue;
    kept += 1;
    if (kept > MAX_DATA_ENTRIES) cache.set(key, { ...entry, data: undefined });
  }
}

export function restoreDocumentBrowserState(stateKey: string): DocumentBrowserStateSnapshot | undefined {
  const snapshot = cache.get(stateKey);
  if (!snapshot) return undefined;
  // Refresh LRU recency.
  cache.delete(stateKey);
  cache.set(stateKey, snapshot);
  return snapshot;
}

export function saveDocumentBrowserState(stateKey: string, snapshot: DocumentBrowserStateSnapshot): void {
  if (closingKeys.has(stateKey)) return;
  const bounded = snapshot.data && snapshot.data.documents.length > MAX_RESTORED_DOCUMENT_ROWS ? { ...snapshot, data: undefined } : snapshot;
  cache.delete(stateKey);
  cache.set(stateKey, bounded);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  trimDataPayloads();
}

export function clearDocumentBrowserState(stateKey: string): void {
  cache.delete(stateKey);
}

/**
 * GridFS bucket and file listings reload on every remount for the same reason
 * DocumentBrowser does, and never got the per-tab condition cache at all. Their
 * payloads are small metadata rows, so one entry per tab carries both the query
 * conditions and the listing.
 */
export interface GridFsBrowserStateSnapshot<TRow> {
  filterInput: string;
  sortInput: string;
  appliedStructuredFilter?: Record<string, unknown> | null;
  filterRules?: DocumentFilterRule[];
  page?: number;
  selectedId?: string;
  /** Identity + conditions the rows were listed under. */
  signature?: string;
  rows?: TRow[];
}

export function restoreGridFsBrowserState<TRow>(stateKey: string): GridFsBrowserStateSnapshot<TRow> | undefined {
  const snapshot = gridFsCache.get(stateKey);
  if (!snapshot) return undefined;
  gridFsCache.delete(stateKey);
  gridFsCache.set(stateKey, snapshot);
  return snapshot as GridFsBrowserStateSnapshot<TRow>;
}

export function saveGridFsBrowserState<TRow>(stateKey: string, snapshot: GridFsBrowserStateSnapshot<TRow>): void {
  if (closingKeys.has(stateKey)) return;
  const bounded = snapshot.rows && snapshot.rows.length > MAX_RESTORED_DOCUMENT_ROWS ? { ...snapshot, rows: undefined, signature: undefined } : snapshot;
  gridFsCache.delete(stateKey);
  gridFsCache.set(stateKey, bounded as GridFsBrowserStateSnapshot<unknown>);
  while (gridFsCache.size > MAX_ENTRIES) {
    const oldest = gridFsCache.keys().next().value;
    if (oldest === undefined) break;
    gridFsCache.delete(oldest);
  }
}

export function clearGridFsBrowserState(stateKey: string): void {
  gridFsCache.delete(stateKey);
}

/** Test seam: drop everything. */
export function resetBrowserStateCaches(): void {
  cache.clear();
  gridFsCache.clear();
  closingKeys.clear();
}
