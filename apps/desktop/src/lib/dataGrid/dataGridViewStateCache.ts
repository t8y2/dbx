/**
 * Session-scoped cache for the view state of a data grid across tab switches.
 *
 * `ContentArea` renders only the active tab, so every `DataGrid` is unmounted on
 * a tab switch and remounted when the user returns. Scroll position and
 * selection live inside the component instance and would otherwise be lost.
 *
 * This cache deliberately holds primitives only — never a `QueryResult`, a rows
 * array, a Vue reactive object, or a callback — so it cannot defeat
 * `queryStore.releaseResultObjectPayload()` or inactive-result eviction.
 *
 * A snapshot is replayed only when the owning grid's `resultViewGeneration`
 * matches the value captured with the snapshot. That token is assigned by
 * `publishResultGeneration` in `queryStore` (new for every dataset replacement,
 * inherited only for disk restore and infinite-scroll append), so a fresh
 * result can never adopt a stale viewport (#7341).
 */

export type DataGridRendererMode = "dom" | "canvas";

/** Cell position in display-row / visible-column coordinates. */
export interface DataGridViewCellPosition {
  rowIndex: number;
  colIndex: number;
}

/**
 * Selection captured in grid display coordinates. A generation match already
 * guarantees the same dataset, so plain indexes are used instead of the
 * identity-token machinery from `dataGridSelectionPersistence.ts` — that path
 * builds a token for every row, which is O(row count) and would violate the
 * capture budget on large results.
 */
export type DataGridViewSelectionSnapshot =
  | { kind: "all"; anchorRowIndex?: number | null }
  | { kind: "rows"; rowIndexes: number[]; contiguous?: boolean; anchorRowIndex?: number | null }
  | { kind: "columns"; columnIndexes: number[] }
  | { kind: "cells"; cellKeys: string[]; anchor?: DataGridViewCellPosition; focus?: DataGridViewCellPosition; selectingAll?: boolean }
  | { kind: "range"; anchor: DataGridViewCellPosition; focus: DataGridViewCellPosition; selectingAll?: boolean; lastClickedRowIndex?: number | null };

export interface DataGridViewSnapshot {
  /** Grid cache key: `resultGridCacheKey(tab)` for results, tab id for data tabs. */
  ownerKey: string;
  /** Logical-result identity the grid was rendering when this was captured. */
  viewGeneration: string;
  /** Bounded deterministic probe; integrity check only, never the authority. */
  probe: string;
  renderer: DataGridRendererMode;
  rowCount: number;
  columnCount: number;
  viewport: { top: number; left: number };
  /** Index-based selection captured in O(selection size). */
  selection?: DataGridViewSelectionSnapshot;
  /** Set when a sparse selection had to be dropped; surfaces the restore-time notice. */
  selectionDropped?: boolean;
}

export interface DataGridViewProbeInput {
  columns: readonly string[];
  columnTypes?: readonly (string | undefined)[];
  rowCount: number;
  firstRow?: readonly unknown[];
  lastRow?: readonly unknown[];
  /** Large-value cells are skipped so the probe never reads a multi-MB value. */
  largeValueCells?: ReadonlyArray<{ row_index: number; column_index: number }>;
  navigation?: {
    whereInput?: string;
    orderByInput?: string;
    pageOffset?: number;
    pageLimit?: number;
    sortColumn?: string;
    sortDirection?: string;
    sortMode?: string;
  };
}

const MAX_ENTRIES = 32;
/**
 * Rollback switch (default on). Set `VITE_DBX_DISABLE_GRID_VIEW_SNAPSHOT=true`
 * to skip capture and restore entirely, which restores the pre-feature
 * behavior without a code change.
 */
export const DATA_GRID_VIEW_SNAPSHOT_RESTORE = import.meta.env?.VITE_DBX_DISABLE_GRID_VIEW_SNAPSHOT !== "true";
/** Per-snapshot serialized budget. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024;
/** Whole-cache serialized budget. */
export const MAX_CACHE_BYTES = 2 * 1024 * 1024;
/** Hard cap on sparse cell-selection entries. */
export const MAX_SPARSE_CELL_ENTRIES = 4096;
const PROBE_COLUMNS = 16;
const PROBE_ROW_COLUMNS = 4;
const PROBE_VALUE_CHARS = 64;

const cache = new Map<string, DataGridViewSnapshot>();
/**
 * Tabs whose snapshots must not be written again. Closing a tab unmounts its
 * grid, whose teardown capture would otherwise re-create the entry the store
 * just deleted. Mirrors `closingPendingSnapshotTabs` in `useDataGridEditor`.
 */
const closingTabs = new Set<string>();
/**
 * Owners already told that an oversized sparse selection was dropped. Cleared
 * only when the owner's snapshot is cleared or its generation changes, so
 * repeated tab switching cannot re-notify.
 */
const overBudgetNotified = new Set<string>();

function ownerBelongsToTab(ownerKey: string, tabId: string): boolean {
  return ownerKey === tabId || ownerKey.startsWith(`${tabId}-`);
}

function isClosingOwner(ownerKey: string): boolean {
  for (const tabId of closingTabs) {
    if (ownerBelongsToTab(ownerKey, tabId)) return true;
  }
  return false;
}

const byteEncoder = new TextEncoder();

/**
 * Serialized size in bytes (UTF-8), so the budgets hold for non-ASCII column
 * and cell content too. Only ever called on the small snapshot object, never
 * on result data.
 */
function snapshotBytes(snapshot: DataGridViewSnapshot): number {
  try {
    return byteEncoder.encode(JSON.stringify(snapshot)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** True when the selection exceeds the sparse-cell budget. */
export function selectionExceedsBudget(selection: DataGridViewSelectionSnapshot | undefined): boolean {
  return !!selection && (selection.kind === "cells" ? selection.cellKeys.length > MAX_SPARSE_CELL_ENTRIES : selection.kind === "rows" && !selection.contiguous && selection.rowIndexes.length > MAX_SPARSE_CELL_ENTRIES);
}

/** Trim an over-budget sparse selection, reporting what was dropped. */
export function clampDataGridViewSelection(selection: DataGridViewSelectionSnapshot): { selection: DataGridViewSelectionSnapshot; droppedSelection: boolean } {
  if (selection.kind === "cells") {
    if (selection.cellKeys.length <= MAX_SPARSE_CELL_ENTRIES) return { selection, droppedSelection: false };
    return { selection: { kind: "cells", cellKeys: [], anchor: selection.anchor, focus: selection.focus }, droppedSelection: true };
  }
  if (selection.kind === "rows" && !selection.contiguous) {
    if (selection.rowIndexes.length <= MAX_SPARSE_CELL_ENTRIES) return { selection, droppedSelection: false };
    return { selection: { kind: "rows", rowIndexes: [], anchorRowIndex: selection.anchorRowIndex }, droppedSelection: true };
  }
  return { selection, droppedSelection: false };
}

/**
 * Shrink a snapshot until it fits the per-snapshot budget: a sparse selection
 * first, then the whole selection. The viewport is always retained.
 */
function degradeToBudget(snapshot: DataGridViewSnapshot): { snapshot: DataGridViewSnapshot; droppedSelection: boolean } {
  if (snapshotBytes(snapshot) <= MAX_SNAPSHOT_BYTES) {
    return { snapshot, droppedSelection: false };
  }
  if (snapshot.selection?.kind === "cells" && snapshot.selection.cellKeys.length) {
    const withoutCells: DataGridViewSnapshot = { ...snapshot, selection: { ...snapshot.selection, cellKeys: [] }, selectionDropped: true };
    if (snapshotBytes(withoutCells) <= MAX_SNAPSHOT_BYTES) {
      return { snapshot: withoutCells, droppedSelection: true };
    }
  }
  return { snapshot: { ...snapshot, selection: undefined, selectionDropped: true }, droppedSelection: !!snapshot.selection };
}

function totalCacheBytes(): number {
  let total = 0;
  for (const snapshot of cache.values()) total += snapshotBytes(snapshot);
  return total;
}

function evictOldest(): boolean {
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return false;
  cache.delete(oldest);
  return true;
}

/**
 * Store a snapshot for `ownerKey`, degrading it to fit the budgets. Returns
 * whether a selection had to be dropped, so the caller can surface the one-shot
 * notice.
 */
export function saveDataGridViewSnapshot(snapshot: DataGridViewSnapshot): { droppedSelection: boolean } {
  if (isClosingOwner(snapshot.ownerKey)) return { droppedSelection: false };
  const { snapshot: fitted, droppedSelection } = degradeToBudget(snapshot);
  cache.delete(snapshot.ownerKey);
  cache.set(snapshot.ownerKey, fitted);
  while (cache.size > MAX_ENTRIES) {
    if (!evictOldest()) break;
  }
  while (cache.size > 1 && totalCacheBytes() > MAX_CACHE_BYTES) {
    if (!evictOldest()) break;
  }
  return { droppedSelection };
}

/** Read a snapshot without consuming it, refreshing its LRU recency. */
export function peekDataGridViewSnapshot(ownerKey: string): DataGridViewSnapshot | undefined {
  const snapshot = cache.get(ownerKey);
  if (!snapshot) return undefined;
  cache.delete(ownerKey);
  cache.set(ownerKey, snapshot);
  return snapshot;
}

/**
 * Drop a replayed snapshot after a successful restore, keeping the over-budget
 * notice marker so switching back and forth cannot re-notify.
 */
export function consumeDataGridViewSnapshot(ownerKey: string): void {
  cache.delete(ownerKey);
}

/** Drop a single owner's snapshot and its notice marker. */
export function clearDataGridViewSnapshot(ownerKey: string): void {
  cache.delete(ownerKey);
  // Deleting while iterating a Set/Map is safe: iteration skips removed entries.
  for (const key of overBudgetNotified) {
    if (key.startsWith(`${ownerKey} `)) overBudgetNotified.delete(key);
  }
}

/** Drop every snapshot belonging to a tab (owner keys are `${tabId}-...`). */
export function clearDataGridViewSnapshotsForTab(tabId: string): void {
  for (const key of cache.keys()) {
    if (ownerBelongsToTab(key, tabId)) cache.delete(key);
  }
  for (const key of overBudgetNotified) {
    if (ownerBelongsToTab(key, tabId) || key.startsWith(`${tabId} `)) overBudgetNotified.delete(key);
  }
}

/**
 * Clear a tab's snapshots and block new writes for a short window, so the grid
 * teardown capture cannot resurrect an entry after the tab is closed or its
 * result cleared.
 */
export function beginClosingDataGridViewSnapshotsForTab(tabId: string): void {
  closingTabs.add(tabId);
  // Some test environments stub `window` without timers, so a bare
  // `window.setTimeout` would throw while clearing a result.
  const schedule = typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout.bind(window) : setTimeout;
  schedule(() => closingTabs.delete(tabId), 5000);
  clearDataGridViewSnapshotsForTab(tabId);
}

/** Test seam: drop everything. */
export function resetDataGridViewSnapshots(): void {
  cache.clear();
  overBudgetNotified.clear();
  closingTabs.clear();
}

export function dataGridViewSnapshotCacheSize(): number {
  return cache.size;
}

export function dataGridViewSnapshotCacheBytes(): number {
  return totalCacheBytes();
}

/**
 * One-shot notice bookkeeping for a dropped selection. Returns true the first
 * time this owner+generation combination reports a drop, and false on every
 * later call until the snapshot is cleared or the generation changes.
 */
export function shouldNotifyOverBudgetSelection(ownerKey: string, viewGeneration: string): boolean {
  const marker = `${ownerKey} ${viewGeneration}`;
  if (overBudgetNotified.has(marker)) return false;
  overBudgetNotified.add(marker);
  return true;
}

function probeValue(value: unknown, skip: boolean): string {
  if (skip) return "";
  if (value === null) return " ";
  const text = typeof value === "string" ? value : String(value);
  return text.length > PROBE_VALUE_CHARS ? text.slice(0, PROBE_VALUE_CHARS) : text;
}

/**
 * Deterministic bounded fingerprint of a result. Used only to detect cache
 * corruption or wiring mistakes: it must never authorize a restore by itself.
 */
export function buildDataGridViewProbe(input: DataGridViewProbeInput): string {
  const skip = new Set((input.largeValueCells ?? []).map((cell) => `${cell.row_index}:${cell.column_index}`));
  const rowProbe = (row: readonly unknown[] | undefined, rowIndex: number): string => {
    if (!row) return "";
    const cells: string[] = [];
    const limit = Math.min(PROBE_ROW_COLUMNS, row.length);
    for (let columnIndex = 0; columnIndex < limit; columnIndex += 1) {
      cells.push(probeValue(row[columnIndex], skip.has(`${rowIndex}:${columnIndex}`)));
    }
    return cells.join("");
  };
  const navigation = input.navigation;
  return JSON.stringify({
    columns: input.columns.slice(0, PROBE_COLUMNS),
    columnTypes: input.columnTypes?.slice(0, PROBE_COLUMNS),
    rowCount: input.rowCount,
    first: rowProbe(input.firstRow, 0),
    last: rowProbe(input.lastRow, Math.max(0, input.rowCount - 1)),
    nav: navigation ? [navigation.whereInput ?? "", navigation.orderByInput ?? "", navigation.pageOffset ?? 0, navigation.pageLimit ?? 0, navigation.sortColumn ?? "", navigation.sortDirection ?? "", navigation.sortMode ?? ""] : undefined,
  });
}
