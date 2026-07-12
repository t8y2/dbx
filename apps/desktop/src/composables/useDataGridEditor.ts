import { ref, computed, nextTick, watch, getCurrentInstance, onActivated, onBeforeUnmount, onDeactivated, onMounted, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { coerceDataGridCellValue, dataGridCellEditorText } from "@/lib/dataGrid/dataGridCellCoercion";
import { normalizeDataGridSaveError } from "@/lib/dataGrid/dataGridSql";
import { rowStatusFilterAfterAddingRow, type RowStatusFilter } from "@/lib/dataGrid/gridRowStatus";
import { supportsDataGridTransaction } from "@/lib/table/tableEditing";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { assessProductionSql, productionContextForDatabase } from "@/lib/database/productionSafety";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import { DBX_NEO4J_ELEMENT_ID_COLUMN, DBX_ROWID_COLUMN } from "@/lib/table/tableEditing";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDraft?: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
}

export const DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID = Number.MIN_SAFE_INTEGER;

type RowKind = "none" | "existing" | "new" | "draft";

type CommitEditResult =
  | {
      changed: false;
      rowKind: RowKind;
    }
  | {
      changed: true;
      rowKind: Exclude<RowKind, "none">;
    };

interface CommitEditOptions {
  promoteDraft?: boolean;
  explicitValue?: string | null;
}

type GridScrollerRef =
  | HTMLElement
  | {
      $el?: HTMLElement;
      el?: HTMLElement | { value?: HTMLElement };
      scrollToItem?: (index: number) => void;
      scrollToPosition?: (position: number) => void;
    };

export interface CustomSaveHandler {
  save: (changes: { dirtyRows: Map<number, Map<number, CellValue>>; newRows: CellValue[][]; deletedRows: Set<number>; columns: string[]; rows: CellValue[][] }) => Promise<void>;
  applySavedChanges?: (changes: { dirtyRows: Map<number, Map<number, CellValue>>; columns: string[] }) => void;
  preview?: (changes: { dirtyRows: Map<number, Map<number, CellValue>>; newRows: CellValue[][]; deletedRows: Set<number>; columns: string[]; rows: CellValue[][] }) => Promise<string[]>;
  canInsert?: boolean;
  canDelete?: boolean;
  readonlyColumns?: string[];
  supportsInsert?: boolean;
  targetLabel?: string;
}

export interface UseDataGridEditorOptions {
  result: ComputedRef<{ columns: string[]; rows: CellValue[][] }>;
  editable: ComputedRef<boolean | undefined>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  connectionId: ComputedRef<string | undefined>;
  database: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<
    | {
        schema?: string;
        tableName: string;
        columns: ColumnInfo[];
        primaryKeys: string[];
      }
    | undefined
  >;
  sourceColumns?: ComputedRef<Array<string | undefined> | undefined>;
  canEditExistingRows?: ComputedRef<boolean>;
  onExecuteSql: ComputedRef<((sql: string) => Promise<void>) | undefined>;
  customSaveHandler?: ComputedRef<CustomSaveHandler | undefined>;
  sql: ComputedRef<string | undefined>;
  searchText: Ref<string>;
  whereFilterInput: Ref<string>;
  currentWhereInput: ComputedRef<string | undefined>;
  orderByInput: Ref<string>;
  rowStatusFilter: Ref<RowStatusFilter>;
  dataGridQuickEntryEnabled?: ComputedRef<boolean>;
  initialEditColumn?: ComputedRef<number>;
  getRowItem: (rowId: number) => RowItem | undefined;
  pageSize: Ref<number>;
  currentPage: Ref<number>;
  cacheKey?: ComputedRef<string | undefined>;
  emit: {
    (event: "reload", sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number): void;
  };
}

interface PendingChangesSnapshot {
  newRows: CellValue[][];
  quickEntryDraftRow?: CellValue[];
  dirtyRows: Map<number, Map<number, CellValue>>;
  deletedRows: Set<number>;
  editingCell?: { rowId: number; col: number } | null;
  editValue?: string;
  transactionActive?: boolean;
  scroll?: { top: number; left: number };
  columnCount: number;
  rowCount: number;
}

interface PendingSaveSnapshot {
  newRows: CellValue[][];
  newRowRefs: CellValue[][];
  dirtyRows: Map<number, Map<number, CellValue>>;
  deletedRows: Set<number>;
}

interface SaveChangesOptions {
  autoSave?: boolean;
}

interface QueuedAutoSaveChange {
  sourceIndex: number;
  col: number;
  value: CellValue;
}

type PendingChangesHistorySnapshot = Pick<PendingChangesSnapshot, "newRows" | "quickEntryDraftRow" | "dirtyRows" | "deletedRows" | "transactionActive">;

const pendingChangesCache = new Map<string, PendingChangesSnapshot>();
const closingPendingSnapshotTabs = new Set<string>();
const BEFORE_TAB_SWITCH_EVENT = "dbx:before-tab-switch";
const MAX_PENDING_CHANGES_HISTORY = 100;

function dataGridRowsIdentityChanged(previousRows: CellValue[][] | undefined, nextRows: CellValue[][]): boolean {
  if (!previousRows) return true;
  if (previousRows.length !== nextRows.length) return true;
  return previousRows.some((row, index) => row !== nextRows[index]);
}

function cacheKeyBelongsToTab(cacheKey: string, tabId: string) {
  return cacheKey === tabId || cacheKey.startsWith(`${tabId}-`);
}

function closedTabIdForCacheKey(cacheKey: string): string | undefined {
  for (const tabId of closingPendingSnapshotTabs) {
    if (cacheKeyBelongsToTab(cacheKey, tabId)) return tabId;
  }
  return undefined;
}

export function clearDataGridPendingSnapshotsForTab(tabId: string) {
  closingPendingSnapshotTabs.add(tabId);
  if (typeof window !== "undefined") {
    window.setTimeout(() => closingPendingSnapshotTabs.delete(tabId), 5000);
  } else {
    setTimeout(() => closingPendingSnapshotTabs.delete(tabId), 5000);
  }
  pendingChangesCache.delete(tabId);
  for (const key of pendingChangesCache.keys()) {
    if (cacheKeyBelongsToTab(key, tabId)) pendingChangesCache.delete(key);
  }
}

export function useDataGridEditor(options: UseDataGridEditorOptions) {
  const connectionStore = useConnectionStore();
  const historyStore = useHistoryStore();
  const productionSafetyStore = useProductionSafetyStore();

  const {
    result,
    editable,
    databaseType,
    connectionId,
    database,
    tableMeta,
    sourceColumns = computed(() => undefined),
    canEditExistingRows = computed(() => true),
    onExecuteSql,
    customSaveHandler,
    sql,
    searchText,
    orderByInput,
    rowStatusFilter,
    dataGridQuickEntryEnabled = computed(() => false),
    initialEditColumn,
    getRowItem,
    pageSize,
    currentPage,
    cacheKey,
  } = options;

  const editingCell = ref<{ rowId: number; col: number } | null>(null);
  const editValue = ref("");
  const scrollerRef = ref<GridScrollerRef | null>(null);
  const dirtyRows = ref<Map<number, Map<number, CellValue>>>(new Map());
  const newRows = ref<CellValue[][]>([]);
  const deletedRows = ref<Set<number>>(new Set());
  const quickEntryDraftRow = ref<CellValue[]>([]);
  const undoStack = ref<PendingChangesHistorySnapshot[]>([]);
  const redoStack = ref<PendingChangesHistorySnapshot[]>([]);
  const pendingChangesVersion = ref(0);
  let restoredEditingCell = false;
  let restoredTransactionActive = false;
  let suppressNextBlurCommit = false;
  let pendingAutoSaveRequested = false;
  const queuedAutoSaveChanges = new Map<string, QueuedAutoSaveChange>();
  let draftPromotionScheduled = false;
  const savingNewRows = new WeakSet<CellValue[]>();
  let pendingScrollRestore: PendingChangesSnapshot["scroll"] | undefined;
  let saveScrollSnapshotTimer = 0;
  let componentActive = true;

  // Restore cached pending changes from a previous instance (e.g. after result eviction + reload)
  const key = cacheKey?.value;
  if (key) {
    const cached = pendingChangesCache.get(key);
    if (cached && cached.columnCount === result.value.columns.length && cached.rowCount === result.value.rows.length) {
      newRows.value = cached.newRows;
      quickEntryDraftRow.value = cached.quickEntryDraftRow ? [...cached.quickEntryDraftRow] : [];
      dirtyRows.value = cached.dirtyRows;
      deletedRows.value = cached.deletedRows;
      editingCell.value = cached.editingCell ?? null;
      editValue.value = cached.editValue ?? "";
      restoredEditingCell = !!cached.editingCell;
      restoredTransactionActive = cached.transactionActive === true;
      pendingScrollRestore = cached.scroll;
      pendingChangesCache.delete(key);
    } else {
      pendingChangesCache.delete(key);
    }
  }

  const dirtyRowCount = computed(() => dirtyRows.value.size);
  const newRowCount = computed(() => newRows.value.length);
  const deletedRowCount = computed(() => deletedRows.value.size);
  const pendingChangeCount = computed(() => dirtyRowCount.value + newRowCount.value + deletedRowCount.value);
  const hasPendingChanges = computed(() => pendingChangeCount.value > 0);
  const canUndoPendingChange = computed(() => undoStack.value.length > 0);
  const canRedoPendingChange = computed(() => redoStack.value.length > 0);
  const resolvedDatabaseType = computed(() => databaseType.value ?? effectiveDatabaseTypeForConnection(connectionStore.getConfig(connectionId.value ?? "")));

  // --- Transaction state ---
  const transactionActive = ref(false);
  const isSaving = ref(false);
  const saveError = ref("");

  const hasBackendSaveTarget = computed(() => !!connectionId.value && !!tableMeta.value);
  const useTransaction = computed(() => editable.value && supportsDataGridTransaction(resolvedDatabaseType.value) && (!!customSaveHandler?.value || hasBackendSaveTarget.value));

  if (hasPendingChanges.value && useTransaction.value) {
    transactionActive.value = true;
  }
  if (restoredTransactionActive && useTransaction.value) transactionActive.value = true;
  if (restoredEditingCell) {
    focusEditInput();
  }

  function focusEditInput(select = true) {
    const focusInput = () => {
      if (typeof document === "undefined") return;
      const root = getScrollerElement()?.closest("[data-grid-root]");
      const input = (root ?? document).querySelector(".cell-edit-input") as HTMLInputElement | HTMLTextAreaElement | null;
      input?.focus();
      if (select && input) {
        if (input instanceof HTMLTextAreaElement && input.dataset.expandedCellEditor === "true") {
          input.setSelectionRange?.(0, 0);
          input.scrollTop = 0;
        } else {
          input.select();
          input.setSelectionRange?.(0, input.value.length);
        }
      }
    };
    nextTick(() => {
      focusInput();
      if (typeof requestAnimationFrame === "undefined") return;
      let attempts = 0;
      const focusNextFrame = () => {
        focusInput();
        attempts += 1;
        if (attempts < 3) requestAnimationFrame(focusNextFrame);
      };
      requestAnimationFrame(focusNextFrame);
    });
  }

  function enterTransaction() {
    transactionActive.value = true;
  }

  function exitTransaction() {
    transactionActive.value = false;
  }

  function touchPendingChanges() {
    pendingChangesVersion.value++;
  }

  function pendingChangesSnapshot(): PendingChangesHistorySnapshot {
    return {
      newRows: newRows.value.map((row) => [...row]),
      quickEntryDraftRow: quickEntryDraftRow.value.length > 0 ? [...quickEntryDraftRow.value] : undefined,
      dirtyRows: new Map([...dirtyRows.value].map(([rowIndex, changes]) => [rowIndex, new Map(changes)])),
      deletedRows: new Set(deletedRows.value),
      transactionActive: transactionActive.value,
    };
  }

  function restorePendingChangesSnapshot(snapshot: PendingChangesHistorySnapshot) {
    newRows.value = snapshot.newRows.map((row) => [...row]);
    quickEntryDraftRow.value = snapshot.quickEntryDraftRow ? [...snapshot.quickEntryDraftRow] : emptyDraftRow();
    dirtyRows.value = new Map([...snapshot.dirtyRows].map(([rowIndex, changes]) => [rowIndex, new Map(changes)]));
    deletedRows.value = new Set(snapshot.deletedRows);
    transactionActive.value = snapshot.transactionActive === true && useTransaction.value === true;
    queuedAutoSaveChanges.clear();
    editingCell.value = null;
    touchPendingChanges();
  }

  function pushUndoSnapshot() {
    undoStack.value = [...undoStack.value.slice(-MAX_PENDING_CHANGES_HISTORY + 1), pendingChangesSnapshot()];
    redoStack.value = [];
  }

  function clearPendingChangeHistory() {
    undoStack.value = [];
    redoStack.value = [];
  }

  function undoPendingChange() {
    const snapshot = undoStack.value[undoStack.value.length - 1];
    if (!snapshot) return;
    undoStack.value = undoStack.value.slice(0, -1);
    redoStack.value = [...redoStack.value, pendingChangesSnapshot()];
    restorePendingChangesSnapshot(snapshot);
  }

  function redoPendingChange() {
    const snapshot = redoStack.value[redoStack.value.length - 1];
    if (!snapshot) return;
    redoStack.value = redoStack.value.slice(0, -1);
    undoStack.value = [...undoStack.value, pendingChangesSnapshot()];
    restorePendingChangesSnapshot(snapshot);
  }

  // --- Scroll helpers ---
  let isCancelling = false;
  let isCommitting = false;
  let cancelScrollRestoreFrame = 0;
  let resetScrollFrame = 0;
  let resetScrollAfterResult = false;

  function getScrollerElement(): HTMLElement | null {
    const scroller = scrollerRef.value;
    if (!scroller) return null;
    if (scroller instanceof HTMLElement) return scroller;
    if (scroller.$el instanceof HTMLElement) return scroller.$el;
    if (scroller.el instanceof HTMLElement) return scroller.el;
    if (scroller.el?.value instanceof HTMLElement) return scroller.el.value;
    return null;
  }

  function scrollGridToTop() {
    const scroller = scrollerRef.value;
    if (scroller && !(scroller instanceof HTMLElement)) {
      scroller.scrollToItem?.(0);
      scroller.scrollToPosition?.(0);
    }
    const el = getScrollerElement();
    if (el) el.scrollTop = 0;
  }

  function resetGridVerticalScroll(afterResult = false) {
    if (afterResult) resetScrollAfterResult = true;
    if (resetScrollFrame) cancelAnimationFrame(resetScrollFrame);
    scrollGridToTop();
    nextTick(() => {
      scrollGridToTop();
      resetScrollFrame = requestAnimationFrame(() => {
        scrollGridToTop();
        resetScrollFrame = 0;
      });
    });
  }

  function preserveScrollPosition() {
    const el = getScrollerElement();
    if (!el) return () => {};
    const top = el.scrollTop;
    const left = el.scrollLeft;
    return () => {
      el.scrollTop = top;
      el.scrollLeft = left;
    };
  }

  function readScrollPosition(): PendingChangesSnapshot["scroll"] | undefined {
    const el = getScrollerElement();
    if (!el) return undefined;
    const top = Math.max(0, el.scrollTop);
    const left = Math.max(0, el.scrollLeft);
    if (top === 0 && left === 0) return undefined;
    return { top, left };
  }

  function applyScrollPosition(scroll: PendingChangesSnapshot["scroll"] | undefined) {
    if (!scroll) return;
    const restoreScroll = () => {
      const scroller = scrollerRef.value;
      if (scroller && !(scroller instanceof HTMLElement)) {
        scroller.scrollToPosition?.(scroll.top);
      }
      const el = getScrollerElement();
      if (!el) return;
      el.scrollTo?.({ top: scroll.top, left: scroll.left });
      el.scrollTop = scroll.top;
      el.scrollLeft = scroll.left;
    };
    restoreScrollAcrossFrames(restoreScroll);
  }

  function recordScrollPosition(scroll = readScrollPosition()) {
    pendingScrollRestore = scroll;
    const k = cacheKey?.value;
    if (!k || typeof window === "undefined") return;
    if (saveScrollSnapshotTimer) window.clearTimeout(saveScrollSnapshotTimer);
    saveScrollSnapshotTimer = window.setTimeout(() => {
      saveScrollSnapshotTimer = 0;
      savePendingSnapshot(true, true);
    }, 120);
  }

  function focusScrollerWithoutScrolling() {
    const el = getScrollerElement();
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }

  function restoreScrollAcrossFrames(restoreScroll: () => void) {
    if (cancelScrollRestoreFrame) cancelAnimationFrame(cancelScrollRestoreFrame);
    restoreScroll();
    nextTick(() => {
      restoreScroll();
      let attempts = 0;
      const restoreNextFrame = () => {
        restoreScroll();
        attempts += 1;
        if (attempts >= 8) {
          cancelScrollRestoreFrame = 0;
          isCancelling = false;
          return;
        }
        cancelScrollRestoreFrame = requestAnimationFrame(restoreNextFrame);
      };
      cancelScrollRestoreFrame = requestAnimationFrame(restoreNextFrame);
    });
  }

  function getResetScrollAfterResult() {
    return resetScrollAfterResult;
  }

  function clearResetScrollAfterResult() {
    resetScrollAfterResult = false;
  }

  function cleanupFrames() {
    if (resetScrollFrame) cancelAnimationFrame(resetScrollFrame);
    if (cancelScrollRestoreFrame) cancelAnimationFrame(cancelScrollRestoreFrame);
    if (saveScrollSnapshotTimer) window.clearTimeout(saveScrollSnapshotTimer);
  }

  // --- Cell value coercion ---
  function coerceCellValue(value: string, oldValue: CellValue | undefined, columnIndex: number): CellValue {
    return coerceDataGridCellValue({
      value,
      oldValue,
      databaseType: resolvedDatabaseType.value,
      columnInfo: tableColumnForGridColumn(columnIndex),
    }) as CellValue;
  }

  function tableColumnForGridColumn(columnIndex: number): ColumnInfo | undefined {
    const columnName = sourceColumns.value?.[columnIndex] ?? result.value.columns[columnIndex];
    if (!columnName) return undefined;
    return tableMeta.value?.columns.find((column) => column.name.toLowerCase() === columnName.toLowerCase());
  }

  function canEditColumn(columnIndex: number): boolean {
    const sources = sourceColumns.value;
    return !sources || sources[columnIndex] !== undefined;
  }

  // --- Row data helpers ---
  function rowDataWithChanges(row: CellValue[], sourceIndex: number): CellValue[] {
    const dirty = dirtyRows.value.get(sourceIndex);
    if (!dirty?.size) return row;
    return row.map((v, colIdx) => (dirty.has(colIdx) ? dirty.get(colIdx)! : v));
  }

  function editingSourceRowItem(rowId: number): RowItem | undefined {
    if (!dataGridQuickEntryEnabled.value || rowId < 0) return undefined;
    const row = result.value.rows[rowId];
    if (!row || deletedRows.value.has(rowId)) return undefined;
    const dirty = dirtyRows.value.get(rowId);
    return {
      id: rowId,
      sourceIndex: rowId,
      data: rowDataWithChanges(row, rowId),
      isNew: false,
      isDeleted: false,
      isDirtyCol: result.value.columns.map((_, colIdx) => !!dirty?.has(colIdx)),
      status: dirty?.size ? "edited" : "clean",
    };
  }

  function emptyDraftRow(): CellValue[] {
    return result.value.columns.map(() => null);
  }

  function ensureQuickEntryDraftRow() {
    if (quickEntryDraftRow.value.length !== result.value.columns.length) {
      quickEntryDraftRow.value = emptyDraftRow();
    }
  }

  function draftRowHasValue(row = quickEntryDraftRow.value): boolean {
    return row.some((value) => value !== null && String(value).trim() !== "");
  }

  function isSavingNewRow(item: Pick<RowItem, "isNew" | "data"> | undefined): boolean {
    return !!item?.isNew && savingNewRows.has(item.data);
  }

  function queuedAutoSaveKey(sourceIndex: number, col: number): string {
    return `${sourceIndex}:${col}`;
  }

  function rememberQueuedAutoSaveChange(sourceIndex: number, col: number, value: CellValue) {
    queuedAutoSaveChanges.set(queuedAutoSaveKey(sourceIndex, col), { sourceIndex, col, value });
  }

  function applyQueuedAutoSaveChanges(savedSnapshot?: PendingSaveSnapshot) {
    if (queuedAutoSaveChanges.size === 0) return false;
    let applied = false;
    for (const change of queuedAutoSaveChanges.values()) {
      if (deletedRows.value.has(change.sourceIndex) || !canEditExistingRows.value) continue;
      const oldVal = result.value.rows[change.sourceIndex]?.[change.col];
      const savedChanges = savedSnapshot?.dirtyRows.get(change.sourceIndex);
      const baseline = savedChanges?.has(change.col) ? savedChanges.get(change.col) : oldVal;
      if (change.value !== baseline) {
        if (!dirtyRows.value.has(change.sourceIndex)) dirtyRows.value.set(change.sourceIndex, new Map());
        dirtyRows.value.get(change.sourceIndex)!.set(change.col, change.value);
        applied = true;
      } else {
        const rowChanges = dirtyRows.value.get(change.sourceIndex);
        rowChanges?.delete(change.col);
        if (rowChanges?.size === 0) dirtyRows.value.delete(change.sourceIndex);
      }
    }
    queuedAutoSaveChanges.clear();
    dirtyRows.value = new Map(dirtyRows.value);
    return applied;
  }

  async function promoteQuickEntryDraftRow() {
    draftPromotionScheduled = false;
    ensureQuickEntryDraftRow();
    if (!draftRowHasValue()) {
      quickEntryDraftRow.value = emptyDraftRow();
      return;
    }
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    newRows.value = [...newRows.value, [...quickEntryDraftRow.value]];
    quickEntryDraftRow.value = emptyDraftRow();
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
    if (dataGridQuickEntryEnabled.value) {
      await saveChanges({ autoSave: true });
    }
  }

  function scheduleQuickEntryDraftPromotion() {
    if (draftPromotionScheduled) return;
    draftPromotionScheduled = true;
    void Promise.resolve().then(promoteQuickEntryDraftRow);
  }

  // --- Inline editing ---
  function startEdit(rowId: number, colIdx: number) {
    if (!editable.value) return;
    if (!canEditColumn(colIdx)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;
    if (!item.isNew && !item.isDraft && !canEditExistingRows.value) return;
    if (isSavingNewRow(item)) return;
    isCancelling = false;
    suppressNextBlurCommit = false;
    editingCell.value = { rowId, col: colIdx };
    const val = item?.data[colIdx] ?? null;
    editValue.value = dataGridCellEditorText({
      value: val,
      databaseType: resolvedDatabaseType.value,
      columnInfo: tableColumnForGridColumn(colIdx),
    });
    focusEditInput();
  }

  function commitEdit(options: CommitEditOptions = {}): CommitEditResult {
    if (isCancelling || isCommitting) return { changed: false, rowKind: "none" };
    if (!editingCell.value) return { changed: false, rowKind: "none" };
    isCommitting = true;
    const { rowId, col } = editingCell.value;
    const item = getRowItem(rowId) ?? editingSourceRowItem(rowId);
    if (!item || item.isDeleted) {
      editingCell.value = null;
      isCommitting = false;
      return { changed: false, rowKind: "none" };
    }

    if (item.isDraft) {
      ensureQuickEntryDraftRow();
      const oldVal = quickEntryDraftRow.value[col] ?? null;
      const newVal = options.explicitValue !== undefined ? options.explicitValue : coerceCellValue(editValue.value, oldVal, col);
      const nextDraftRow = [...quickEntryDraftRow.value];
      nextDraftRow[col] = newVal;
      if (newVal !== oldVal) pushUndoSnapshot();
      quickEntryDraftRow.value = nextDraftRow;
      editingCell.value = null;
      isCommitting = false;
      if (!draftRowHasValue(nextDraftRow)) {
        quickEntryDraftRow.value = emptyDraftRow();
        return { changed: false, rowKind: "draft" };
      }
      if (options.promoteDraft === false) {
        return { changed: false, rowKind: "draft" };
      }
      rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
      newRows.value = [...newRows.value, nextDraftRow];
      quickEntryDraftRow.value = emptyDraftRow();
      touchPendingChanges();
      if (useTransaction.value && !transactionActive.value) {
        enterTransaction();
      }
      return { changed: true, rowKind: "draft" };
    }

    if (item.isNew && item.newIndex !== undefined) {
      const oldVal = newRows.value[item.newIndex]?.[col];
      const newVal = options.explicitValue !== undefined ? options.explicitValue : coerceCellValue(editValue.value, oldVal, col);
      const changed = newVal !== oldVal;
      if (changed) pushUndoSnapshot();
      if (newRows.value[item.newIndex]) {
        newRows.value[item.newIndex][col] = newVal;
      }
      newRows.value = [...newRows.value];
      if (changed) touchPendingChanges();
      editingCell.value = null;
      isCommitting = false;
      return changed ? { changed: true, rowKind: "new" } : { changed: false, rowKind: "new" };
    }

    if (item.sourceIndex === undefined) {
      editingCell.value = null;
      isCommitting = false;
      return { changed: false, rowKind: "none" };
    }
    if (!canEditExistingRows.value) {
      editingCell.value = null;
      isCommitting = false;
      return { changed: false, rowKind: "existing" };
    }

    const oldVal = result.value.rows[item.sourceIndex]?.[col];
    const newVal = options.explicitValue !== undefined ? options.explicitValue : coerceCellValue(editValue.value, oldVal, col);
    const changed = newVal !== item.data[col];
    if (newVal !== oldVal) {
      if (changed) pushUndoSnapshot();
      if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
      dirtyRows.value.get(item.sourceIndex)!.set(col, newVal);
      if (useTransaction.value && !transactionActive.value) {
        enterTransaction();
      }
    } else {
      const rowChanges = dirtyRows.value.get(item.sourceIndex);
      if (rowChanges?.has(col)) pushUndoSnapshot();
      rowChanges?.delete(col);
      if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
    }
    dirtyRows.value = new Map(dirtyRows.value);
    if (changed) touchPendingChanges();
    editingCell.value = null;
    isCommitting = false;
    if (dataGridQuickEntryEnabled.value && isSaving.value && changed) {
      rememberQueuedAutoSaveChange(item.sourceIndex, col, newVal);
    }
    return changed ? { changed: true, rowKind: "existing" } : { changed: false, rowKind: "existing" };
  }

  async function commitEditAndMaybeAutoSave(options: CommitEditOptions = {}) {
    const result = commitEdit(options);
    if (dataGridQuickEntryEnabled.value && options.promoteDraft !== false && result.changed) {
      await saveChanges({ autoSave: true });
    }
  }

  async function commitEditFromBlur(options: CommitEditOptions = {}) {
    if (suppressNextBlurCommit) {
      suppressNextBlurCommit = false;
      return;
    }
    await commitEditAndMaybeAutoSave(options);
  }

  function applyCellValue(rowId: number, col: number, value: string | null) {
    if (!canEditColumn(col)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;

    if (item.isDraft) {
      ensureQuickEntryDraftRow();
      const oldVal = quickEntryDraftRow.value[col] ?? null;
      const nextDraftRow = [...quickEntryDraftRow.value];
      nextDraftRow[col] = value === null ? null : coerceCellValue(value, oldVal, col);
      if (nextDraftRow[col] === oldVal) return;
      pushUndoSnapshot();
      quickEntryDraftRow.value = draftRowHasValue(nextDraftRow) ? nextDraftRow : emptyDraftRow();
      touchPendingChanges();
      scheduleQuickEntryDraftPromotion();
      return;
    }

    if (item.isNew && item.newIndex !== undefined) {
      if (isSavingNewRow(item)) return;
      const row = newRows.value[item.newIndex];
      if (!row) return;
      const oldVal = row[col];
      const newVal = value === null ? null : coerceCellValue(value, oldVal, col);
      if (newVal === oldVal) return;
      pushUndoSnapshot();
      row[col] = newVal;
      newRows.value = [...newRows.value];
      touchPendingChanges();
      return;
    }

    if (item.sourceIndex === undefined) return;
    if (!canEditExistingRows.value) return;

    const oldVal = result.value.rows[item.sourceIndex]?.[col];
    const rowChanges = dirtyRows.value.get(item.sourceIndex);
    const hasPendingCellChange = rowChanges?.has(col) ?? false;
    const currentVal = hasPendingCellChange ? rowChanges!.get(col) : oldVal;
    const newVal = value === null ? null : coerceCellValue(value, oldVal, col);
    if (newVal === currentVal) return;
    if (newVal !== oldVal) {
      pushUndoSnapshot();
      if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
      dirtyRows.value.get(item.sourceIndex)!.set(col, newVal);
      if (useTransaction.value && !transactionActive.value) {
        enterTransaction();
      }
    } else {
      if (hasPendingCellChange) pushUndoSnapshot();
      rowChanges?.delete(col);
      if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
    }
    dirtyRows.value = new Map(dirtyRows.value);
    touchPendingChanges();
  }

  function restoreCellValue(rowId: number, col: number) {
    if (!canEditColumn(col)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;

    if (item.isDraft) {
      ensureQuickEntryDraftRow();
      if (quickEntryDraftRow.value[col] === null) return;
      pushUndoSnapshot();
      const nextDraftRow = [...quickEntryDraftRow.value];
      nextDraftRow[col] = null;
      quickEntryDraftRow.value = draftRowHasValue(nextDraftRow) ? nextDraftRow : emptyDraftRow();
      touchPendingChanges();
      return;
    }

    if (item.isNew && item.newIndex !== undefined) {
      if (isSavingNewRow(item)) return;
      const row = newRows.value[item.newIndex];
      if (!row || row[col] === null) return;
      pushUndoSnapshot();
      row[col] = null;
      newRows.value = [...newRows.value];
      touchPendingChanges();
      return;
    }

    if (item.sourceIndex === undefined) return;
    if (!canEditExistingRows.value) return;
    const rowChanges = dirtyRows.value.get(item.sourceIndex);
    if (!rowChanges?.has(col)) return;
    pushUndoSnapshot();
    rowChanges.delete(col);
    if (rowChanges.size === 0) dirtyRows.value.delete(item.sourceIndex);
    dirtyRows.value = new Map(dirtyRows.value);
    touchPendingChanges();
  }

  function cancelEdit() {
    const restoreScroll = preserveScrollPosition();
    isCancelling = true;
    focusScrollerWithoutScrolling();
    editingCell.value = null;
    restoreScrollAcrossFrames(restoreScroll);
  }

  function onEditKeydown(e: KeyboardEvent) {
    const isExpandedTextarea = typeof HTMLTextAreaElement !== "undefined" && e.target instanceof HTMLTextAreaElement && e.target.dataset.expandedCellEditor === "true";
    if (e.key === "Enter" && (!isExpandedTextarea || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commitEditAndMaybeAutoSave().finally(() => nextTick(focusScrollerWithoutScrolling));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  }

  function addRow() {
    pushUndoSnapshot();
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    newRows.value.push(result.value.columns.map(() => null));
    newRows.value = [...newRows.value];
    touchPendingChanges();
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
    const rowId = -newRows.value.length;
    nextTick(() => {
      const el = getScrollerElement();
      if (el) el.scrollTop = el.scrollHeight;
      startEdit(rowId, initialEditColumn?.value ?? 0);
    });
  }

  function clonedRowData(item: RowItem): CellValue[] {
    const columnInfoByName = new Map((tableMeta.value?.columns ?? []).map((column) => [column.name.toLowerCase(), column]));
    return item.data.map((val, i) => {
      const columnName = result.value.columns[i];
      const columnInfo = columnInfoByName.get(columnName.toLowerCase());
      return shouldClearClonedColumn(columnName, columnInfo) ? null : val;
    });
  }

  function shouldClearClonedColumn(columnName: string, columnInfo: ColumnInfo | undefined): boolean {
    if (resolvedDatabaseType.value === "oracle" && columnName.toUpperCase() === DBX_ROWID_COLUMN) return true;
    if (resolvedDatabaseType.value === "neo4j" && columnName === DBX_NEO4J_ELEMENT_ID_COLUMN) return true;
    const extra = columnInfo?.extra ?? "";
    const columnDefault = columnInfo?.column_default ?? "";
    return /\b(auto_increment|autoincrement|identity|generated)\b/i.test(extra) || /\bnextval\s*\(/i.test(columnDefault);
  }

  function cloneRow(rowId: number) {
    const item = getRowItem(rowId);
    if (!item) return;
    const clonedData = clonedRowData(item);
    pushUndoSnapshot();
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    newRows.value.push(clonedData);
    newRows.value = [...newRows.value];
    touchPendingChanges();
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
    const newRowId = -newRows.value.length;
    nextTick(() => {
      const el = getScrollerElement();
      if (el) el.scrollTop = el.scrollHeight;
      startEdit(newRowId, initialEditColumn?.value ?? 0);
    });
  }

  function cloneRows(rowIds: number[]) {
    const rowsToClone = rowIds.map((rowId) => getRowItem(rowId)).filter(Boolean) as RowItem[];
    if (rowsToClone.length === 0) return;
    pushUndoSnapshot();
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    for (const item of rowsToClone) {
      const clonedData = clonedRowData(item);
      newRows.value.push(clonedData);
    }
    newRows.value = [...newRows.value];
    touchPendingChanges();
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
  }

  function applyDeleteRows(rowIds: number[]) {
    const items = rowIds.map((rowId) => getRowItem(rowId)).filter((item): item is RowItem => !!item);
    if (items.length === 0) return;

    const newIndexes = new Set<number>();
    const sourceIndexes = new Set<number>();
    const deletedRowIds = new Set<number>();

    for (const item of items) {
      if (item.isNew && item.newIndex !== undefined) {
        if (isSavingNewRow(item)) continue;
        newIndexes.add(item.newIndex);
        deletedRowIds.add(item.id);
      } else if (item.sourceIndex !== undefined && canEditExistingRows.value) {
        sourceIndexes.add(item.sourceIndex);
        deletedRowIds.add(item.id);
      }
    }

    if (newIndexes.size === 0 && sourceIndexes.size === 0) return;

    // Batch row deletion into one reactive update so multi-row deletes do not
    // rebuild the entire grid and undo history once per selected row.
    pushUndoSnapshot();
    if (newIndexes.size > 0) {
      [...newIndexes]
        .sort((a, b) => b - a)
        .forEach((newIndex) => {
          newRows.value.splice(newIndex, 1);
        });
      newRows.value = [...newRows.value];
    }
    if (sourceIndexes.size > 0) {
      for (const sourceIndex of sourceIndexes) {
        dirtyRows.value.delete(sourceIndex);
        deletedRows.value.add(sourceIndex);
      }
      dirtyRows.value = new Map(dirtyRows.value);
      deletedRows.value = new Set(deletedRows.value);
    }
    touchPendingChanges();
    if (editingCell.value && deletedRowIds.has(editingCell.value.rowId)) editingCell.value = null;
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
  }

  function applyDeleteRow(rowId: number) {
    applyDeleteRows([rowId]);
  }

  const showDeleteRowConfirm = ref(false);
  const pendingDeleteRowId = ref<number | null>(null);
  const pendingDeleteRowIds = ref<number[]>([]);

  function requestDeleteRow(rowId: number) {
    pendingDeleteRowId.value = rowId;
    showDeleteRowConfirm.value = true;
  }

  function requestDeleteRows(rowIds: number[]) {
    pendingDeleteRowIds.value = rowIds;
    showDeleteRowConfirm.value = true;
  }

  function confirmDeleteRow() {
    if (pendingDeleteRowIds.value.length > 0) {
      applyDeleteRows(pendingDeleteRowIds.value);
      pendingDeleteRowIds.value = [];
      return;
    }
    if (pendingDeleteRowId.value === null) return;
    applyDeleteRow(pendingDeleteRowId.value);
    pendingDeleteRowId.value = null;
  }

  function restoreRow(rowId: number) {
    const item = getRowItem(rowId);
    if (item?.sourceIndex !== undefined && deletedRows.value.has(item.sourceIndex)) {
      pushUndoSnapshot();
      deletedRows.value.delete(item.sourceIndex);
      deletedRows.value = new Set(deletedRows.value);
      touchPendingChanges();
    }
  }

  function restoreRows(rowIds: number[]) {
    const sourceIndexes = rowIds.map((rowId) => getRowItem(rowId)?.sourceIndex).filter((sourceIndex): sourceIndex is number => sourceIndex !== undefined && deletedRows.value.has(sourceIndex));
    if (sourceIndexes.length === 0) return;
    pushUndoSnapshot();
    for (const sourceIndex of sourceIndexes) {
      deletedRows.value.delete(sourceIndex);
    }
    deletedRows.value = new Set(deletedRows.value);
    touchPendingChanges();
  }

  function deleteSelectedRow(contextCell: Ref<{ rowId: number; rowIndex: number; col: number } | null>) {
    if (!contextCell.value) return;
    requestDeleteRow(contextCell.value.rowId);
  }

  // --- Save/Discard ---
  function snapshotPendingSaveChanges(): PendingSaveSnapshot {
    const currentNewRows = [...newRows.value];
    return {
      dirtyRows: new Map([...dirtyRows.value.entries()].map(([rowIndex, changes]) => [rowIndex, new Map(changes)])),
      newRows: currentNewRows.map((row) => [...row]),
      newRowRefs: currentNewRows,
      deletedRows: new Set(deletedRows.value),
    };
  }

  function hasPendingSaveChanges(snapshot: PendingSaveSnapshot) {
    return snapshot.newRows.length > 0 || snapshot.dirtyRows.size > 0 || snapshot.deletedRows.size > 0;
  }

  function applyDirtyRowsToResult(snapshot: PendingSaveSnapshot) {
    for (const [sourceIndex, changes] of snapshot.dirtyRows) {
      const row = result.value.rows[sourceIndex];
      if (row) {
        for (const [colIdx, value] of changes) {
          row[colIdx] = value;
        }
      }
    }
  }

  function clearSavedPendingChanges(snapshot: PendingSaveSnapshot) {
    for (const [sourceIndex, changes] of snapshot.dirtyRows) {
      const liveChanges = dirtyRows.value.get(sourceIndex);
      if (!liveChanges) continue;
      for (const [colIdx, savedValue] of changes) {
        if (liveChanges.get(colIdx) === savedValue) {
          liveChanges.delete(colIdx);
        }
      }
      if (liveChanges.size === 0) {
        dirtyRows.value.delete(sourceIndex);
      }
    }
    dirtyRows.value = new Map(dirtyRows.value);

    if (snapshot.newRows.length > 0) {
      const savedNewRows = new Set(snapshot.newRowRefs);
      newRows.value = newRows.value.filter((row) => !savedNewRows.has(row));
    }

    for (const sourceIndex of snapshot.deletedRows) {
      deletedRows.value.delete(sourceIndex);
    }
    deletedRows.value = new Set(deletedRows.value);
    touchPendingChanges();
  }

  async function finishSaveChanges(savedSnapshot?: PendingSaveSnapshot) {
    isSaving.value = false;
    if (pendingAutoSaveRequested && dataGridQuickEntryEnabled.value) {
      applyQueuedAutoSaveChanges(savedSnapshot);
    } else {
      queuedAutoSaveChanges.clear();
    }
    if (!hasPendingChanges.value) {
      pendingAutoSaveRequested = false;
      return;
    }
    if (pendingAutoSaveRequested && dataGridQuickEntryEnabled.value) {
      pendingAutoSaveRequested = false;
      await saveChanges({ autoSave: true });
    }
  }

  async function finishInterruptedSaveChanges(snapshot: PendingSaveSnapshot) {
    snapshot.newRowRefs.forEach((row) => savingNewRows.delete(row));
    await finishSaveChanges();
  }

  function saveStatementOptions(snapshot = snapshotPendingSaveChanges()) {
    if (!tableMeta.value) return null;
    return {
      databaseType: resolvedDatabaseType.value,
      tableMeta: tableMeta.value,
      columns: result.value.columns,
      sourceColumns: sourceColumns.value,
      rows: result.value.rows,
      dirtyRows: [...snapshot.dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]] as [number, Array<[number, CellValue]>]),
      deletedRows: [...snapshot.deletedRows],
      newRows: snapshot.newRows,
    };
  }

  function tableHistoryTarget() {
    if (!tableMeta.value) return "";
    return [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".");
  }

  function dataChangeOperation(snapshot: PendingSaveSnapshot) {
    const operations = [snapshot.newRows.length > 0 ? "INSERT" : "", snapshot.dirtyRows.size > 0 ? "UPDATE" : "", snapshot.deletedRows.size > 0 ? "DELETE" : ""].filter(Boolean);
    return operations.length === 1 ? operations[0] : "DATA CHANGE";
  }

  async function recordDataGridHistory(statements: string[], rollbackStatements: string[], elapsed: number, snapshot: PendingSaveSnapshot, historyResult?: { affected_rows?: number; success?: boolean; error?: string }) {
    if (!connectionId.value || !tableMeta.value) return;
    const connName = connectionStore.getConfig(connectionId.value)?.name || "";
    const success = historyResult?.success ?? true;
    const details = {
      schema: tableMeta.value.schema,
      table: tableMeta.value.tableName,
      inserted_rows: snapshot.newRows.length,
      updated_rows: snapshot.dirtyRows.size,
      deleted_rows: snapshot.deletedRows.size,
      statements,
      rollback_statements: success ? rollbackStatements : [],
      error: success ? undefined : historyResult?.error,
    };
    await historyStore.add({
      connection_id: connectionId.value,
      connection_name: connName,
      database: database.value ?? "",
      sql: statements.join("\n"),
      execution_time_ms: elapsed,
      success,
      error: success ? undefined : historyResult?.error,
      activity_kind: "data_change",
      operation: dataChangeOperation(snapshot),
      target: tableHistoryTarget(),
      affected_rows: success ? (historyResult?.affected_rows ?? statements.length) : undefined,
      rollback_sql: success && rollbackStatements.length ? rollbackStatements.join("\n") : undefined,
      details_json: JSON.stringify(details),
    });
  }

  async function recordFailedDataGridHistory(statements: string[], rollbackStatements: string[], start: number, snapshot: PendingSaveSnapshot, error: unknown) {
    const message = normalizeDataGridSaveError(databaseType.value, error);
    try {
      await recordDataGridHistory(statements, rollbackStatements, Date.now() - start, snapshot, {
        success: false,
        error: message,
      });
    } catch (historyError) {
      console.warn("[DBX] failed to record data grid history", historyError);
    }
    return message;
  }

  function reloadCurrentData() {
    options.emit("reload", sql.value, searchText.value, options.currentWhereInput.value, orderByInput.value.trim() || undefined, pageSize.value, (currentPage.value - 1) * pageSize.value);
  }

  async function saveChanges(saveOptions: SaveChangesOptions = {}) {
    if (isSaving.value) {
      if (saveOptions.autoSave) pendingAutoSaveRequested = true;
      return;
    }
    const snapshot = snapshotPendingSaveChanges();
    if (!hasPendingSaveChanges(snapshot)) {
      return;
    }
    const customHandler = customSaveHandler?.value;
    const connection = connectionStore.getConfig(connectionId.value ?? "");
    const customHandlerProductionContext = productionContextForDatabase(connection, database.value);
    if (customHandler && customHandlerProductionContext.active) {
      // Custom data sources may not expose SQL, but their row mutations still need the same production interlock.
      if (saveOptions.autoSave) {
        return;
      }
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql: describeDataGridChanges(snapshot),
        connectionName: connection?.name,
        database: database.value,
        productionDatabases: customHandlerProductionContext.databases,
        source: "Data editor",
      });
      if (!confirmed) return;
    }
    if (customHandler && snapshot.newRows.length > 0 && customHandler.supportsInsert !== true && customHandler.canInsert !== true) {
      saveError.value = "当前保存目标不支持新增行。";
      return;
    }
    saveError.value = "";
    isSaving.value = true;
    snapshot.newRowRefs.forEach((row) => savingNewRows.add(row));
    const shouldReloadAfterSave = snapshot.newRows.length > 0 || snapshot.deletedRows.size > 0;

    if (customHandler) {
      try {
        await customHandler.save({
          dirtyRows: snapshot.dirtyRows,
          newRows: snapshot.newRows,
          deletedRows: snapshot.deletedRows,
          columns: result.value.columns,
          rows: result.value.rows,
        });
      } catch (e: any) {
        saveError.value = normalizeDataGridSaveError(databaseType.value, e);
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
      snapshot.newRowRefs.forEach((row) => savingNewRows.delete(row));
      customHandler.applySavedChanges?.({ dirtyRows: snapshot.dirtyRows, columns: result.value.columns });
      applyDirtyRowsToResult(snapshot);
      clearSavedPendingChanges(snapshot);
      if (!hasPendingChanges.value) exitTransaction();
      clearPendingChangeHistory();
      if (shouldReloadAfterSave) {
        reloadCurrentData();
      }
      await finishSaveChanges(snapshot);
      return;
    }

    const stmtOptions = saveStatementOptions(snapshot);
    let preparedSave: Awaited<ReturnType<typeof api.prepareDataGridSave>> | undefined;
    if (stmtOptions) {
      try {
        preparedSave = await api.prepareDataGridSave(stmtOptions);
      } catch (e: any) {
        saveError.value = normalizeDataGridSaveError(databaseType.value, e);
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
    }
    if (preparedSave?.validationError) {
      saveError.value = preparedSave.validationError;
      await finishInterruptedSaveChanges(snapshot);
      return;
    }

    const stmts = preparedSave?.statements ?? [];
    if (stmts.length === 0) {
      await finishInterruptedSaveChanges(snapshot);
      return;
    }
    const rollbackStmts = preparedSave?.rollbackStatements ?? [];
    const productionAssessment = assessProductionSql(stmts.join(";\n"), connection, database.value);
    if (productionAssessment.active && productionAssessment.isMutation) {
      // Autosave must never write production data without an operator reviewing the generated statements.
      if (saveOptions.autoSave) {
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql: stmts.join("\n"),
        connectionName: connection?.name,
        database: database.value,
        productionDatabases: productionAssessment.databases,
        source: "Data editor",
      });
      if (!confirmed) {
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
    }
    const start = Date.now();
    let apiResult: { affected_rows?: number } | undefined;
    console.info("[DBX][dataGrid:save-statements]", {
      databaseType: databaseType.value,
      table: tableMeta.value ? [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".") : undefined,
      statements: stmts,
      rollbackStatements: rollbackStmts,
    });

    if (useTransaction.value && hasBackendSaveTarget.value) {
      try {
        apiResult = await api.executeInTransaction(connectionId.value!, database.value ?? "", stmts, preparedSave?.executionSchema);
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, snapshot, e);
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
    } else if (hasBackendSaveTarget.value) {
      try {
        apiResult = await api.executeBatch(connectionId.value!, database.value ?? "", stmts, preparedSave?.executionSchema);
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, snapshot, e);
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
    } else if (onExecuteSql.value) {
      try {
        for (const sqlStmt of stmts) {
          await onExecuteSql.value(sqlStmt);
        }
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, snapshot, e);
        await finishInterruptedSaveChanges(snapshot);
        return;
      }
    }
    try {
      await recordDataGridHistory(stmts, rollbackStmts, Date.now() - start, snapshot, apiResult);
    } catch (e) {
      console.warn("[DBX] failed to record data grid history", e);
    }
    applyDirtyRowsToResult(snapshot);
    snapshot.newRowRefs.forEach((row) => savingNewRows.delete(row));
    clearSavedPendingChanges(snapshot);
    if (!hasPendingChanges.value) exitTransaction();
    clearPendingChangeHistory();
    if (shouldReloadAfterSave) {
      reloadCurrentData();
    }
    await finishSaveChanges(snapshot);
  }

  function discardChanges() {
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
    quickEntryDraftRow.value = emptyDraftRow();
    queuedAutoSaveChanges.clear();
    editingCell.value = null;
    clearPendingChangeHistory();
    touchPendingChanges();
    exitTransaction();
  }

  // Pending changes reference rows by sourceIndex. When the result set changes
  // (e.g. different WHERE clause, pagination), stale indices point to wrong rows.
  let previousResultRows = result.value.rows;
  watch(
    () => result.value.rows,
    (rows) => {
      if (!dataGridRowsIdentityChanged(previousResultRows, rows)) {
        previousResultRows = rows;
        return;
      }
      previousResultRows = rows;
      pendingScrollRestore = undefined;
      discardChanges();
    },
  );

  function savePendingSnapshot(includeEditing = false, includeScroll = false) {
    const k = cacheKey?.value;
    if (!k) return;
    if (closedTabIdForCacheKey(k)) {
      pendingChangesCache.delete(k);
      return;
    }
    const scroll = includeScroll ? (readScrollPosition() ?? pendingScrollRestore) : undefined;
    if (includeScroll) pendingScrollRestore = scroll;
    const quickEntryDraftRowSnapshot = draftRowHasValue() ? [...quickEntryDraftRow.value] : undefined;
    if (!hasPendingChanges.value && !quickEntryDraftRowSnapshot && !(includeEditing && editingCell.value) && !scroll) {
      pendingChangesCache.delete(k);
      return;
    }
    pendingChangesCache.set(k, {
      newRows: newRows.value.map((r) => [...r]),
      quickEntryDraftRow: quickEntryDraftRowSnapshot,
      dirtyRows: new Map([...dirtyRows.value].map(([i, m]) => [i, new Map(m)])),
      deletedRows: new Set(deletedRows.value),
      editingCell: includeEditing && editingCell.value ? { ...editingCell.value } : null,
      editValue: editValue.value,
      transactionActive: transactionActive.value,
      scroll,
      columnCount: result.value.columns.length,
      rowCount: result.value.rows.length,
    });
  }

  function restorePendingSnapshotFocus() {
    suppressNextBlurCommit = false;
    if (editingCell.value) focusEditInput(true);
    applyScrollPosition(pendingScrollRestore);
  }

  function onBeforeTabSwitch() {
    if (!componentActive) return;
    savePendingSnapshot(true, true);
    if (editingCell.value) suppressNextBlurCommit = true;
  }

  const componentInstance = getCurrentInstance();
  if (componentInstance && typeof window !== "undefined") {
    window.addEventListener(BEFORE_TAB_SWITCH_EVENT, onBeforeTabSwitch);
  }

  if (componentInstance) {
    onMounted(() => {
      componentActive = true;
      applyScrollPosition(pendingScrollRestore);
    });
    onActivated(() => {
      componentActive = true;
      restorePendingSnapshotFocus();
    });
    onDeactivated(() => {
      savePendingSnapshot(true, true);
      componentActive = false;
    });

    // Save pending changes before the component is destroyed so they can be
    // restored if a new DataGrid instance is created for the same tab
    // (e.g. after result eviction + reload).
    onBeforeUnmount(() => {
      savePendingSnapshot(true, true);
      if (typeof window !== "undefined") {
        window.removeEventListener(BEFORE_TAB_SWITCH_EVENT, onBeforeTabSwitch);
      }
    });
  }

  // --- SQL Preview for pending changes ---
  const previewStatements = ref<string[]>([]);
  const isPreviewLoading = ref(false);

  async function previewChanges(): Promise<string[]> {
    isPreviewLoading.value = true;
    previewStatements.value = [];
    try {
      if (customSaveHandler?.value) {
        const preview = customSaveHandler.value.preview;
        if (preview) return await preview({ dirtyRows: dirtyRows.value, newRows: newRows.value, deletedRows: deletedRows.value, columns: result.value.columns, rows: result.value.rows });
        return [];
      }
      const stmtOptions = saveStatementOptions();
      if (!stmtOptions) return [];
      const prepared = await api.prepareDataGridSave(stmtOptions);
      if (prepared?.validationError) {
        saveError.value = prepared.validationError;
        return [];
      }
      const stmts = prepared?.statements ?? [];
      previewStatements.value = stmts;
      return stmts;
    } catch (e: any) {
      saveError.value = normalizeDataGridSaveError(databaseType.value, e);
      return [];
    } finally {
      isPreviewLoading.value = false;
    }
  }

  return {
    editingCell,
    editValue,
    scrollerRef,
    dirtyRows,
    newRows,
    deletedRows,
    quickEntryDraftRow,
    quickEntryDraftRowId: DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID,
    dirtyRowCount,
    newRowCount,
    deletedRowCount,
    pendingChangesVersion,
    pendingChangeCount,
    hasPendingChanges,
    transactionActive,
    isSaving,
    saveError,
    useTransaction,
    enterTransaction,
    exitTransaction,
    startEdit,
    commitEdit,
    commitEditAndMaybeAutoSave,
    commitEditFromBlur,
    applyCellValue,
    restoreCellValue,
    cancelEdit,
    onEditKeydown,
    addRow,
    cloneRow,
    cloneRows,
    applyDeleteRows,
    applyDeleteRow,
    showDeleteRowConfirm,
    pendingDeleteRowId,
    pendingDeleteRowIds,
    requestDeleteRow,
    requestDeleteRows,
    confirmDeleteRow,
    restoreRow,
    restoreRows,
    deleteSelectedRow,
    saveChanges,
    discardChanges,
    canUndoPendingChange,
    canRedoPendingChange,
    undoPendingChange,
    redoPendingChange,
    rowDataWithChanges,
    ensureQuickEntryDraftRow,
    draftRowHasValue,
    isSavingNewRow,
    coerceCellValue,
    canEditColumn,
    resetGridVerticalScroll,
    getResetScrollAfterResult,
    clearResetScrollAfterResult,
    cleanupFrames,
    recordScrollPosition,
    previewStatements,
    isPreviewLoading,
    previewChanges,
    savePendingSnapshot,
    restorePendingSnapshotFocus,
    syncHeaderScroll: (headerRef: Ref<HTMLDivElement | undefined>) => (e: Event) => {
      if (headerRef.value) {
        headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
      }
    },
  };
}

function describeDataGridChanges(snapshot: { newRows: unknown[]; dirtyRows: Map<unknown, unknown>; deletedRows: Set<unknown> }): string {
  const changes = [snapshot.newRows.length ? `INSERT: ${snapshot.newRows.length} row(s)` : "", snapshot.dirtyRows.size ? `UPDATE: ${snapshot.dirtyRows.size} row(s)` : "", snapshot.deletedRows.size ? `DELETE: ${snapshot.deletedRows.size} row(s)` : ""].filter(Boolean);
  return changes.join("\n") || "DATA GRID WRITE";
}
