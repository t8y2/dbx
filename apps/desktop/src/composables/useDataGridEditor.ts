import { ref, computed, nextTick, watch, getCurrentInstance, onActivated, onBeforeUnmount, onDeactivated, onMounted, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/api";
import type { CellValue } from "@/lib/cellValue";
import { coerceDataGridCellValue, dataGridCellEditorText } from "@/lib/dataGridCellCoercion";
import { normalizeDataGridSaveError } from "@/lib/dataGridSql";
import { rowStatusFilterAfterAddingRow, type RowStatusFilter } from "@/lib/gridRowStatus";
import { supportsDataGridTransaction } from "@/lib/tableEditing";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import { DBX_NEO4J_ELEMENT_ID_COLUMN, DBX_ROWID_COLUMN } from "@/lib/tableEditing";
import { effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
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
  preview?: (changes: { dirtyRows: Map<number, Map<number, CellValue>>; newRows: CellValue[][]; deletedRows: Set<number>; columns: string[]; rows: CellValue[][] }) => Promise<string[]>;
  canInsert?: boolean;
  canDelete?: boolean;
  readonlyColumns?: string[];
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
  dirtyRows: Map<number, Map<number, CellValue>>;
  deletedRows: Set<number>;
  editingCell?: { rowId: number; col: number } | null;
  editValue?: string;
  transactionActive?: boolean;
  scroll?: { top: number; left: number };
  columnCount: number;
  rowCount: number;
}

type PendingChangesHistorySnapshot = Pick<PendingChangesSnapshot, "newRows" | "dirtyRows" | "deletedRows" | "transactionActive">;

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
  const undoStack = ref<PendingChangesHistorySnapshot[]>([]);
  const redoStack = ref<PendingChangesHistorySnapshot[]>([]);
  const pendingChangesVersion = ref(0);
  let restoredEditingCell = false;
  let restoredTransactionActive = false;
  let suppressNextBlurCommit = false;
  let pendingScrollRestore: PendingChangesSnapshot["scroll"] | undefined;
  let saveScrollSnapshotTimer = 0;
  let componentActive = true;

  // Restore cached pending changes from a previous instance (e.g. after result eviction + reload)
  const key = cacheKey?.value;
  if (key) {
    const cached = pendingChangesCache.get(key);
    if (cached && cached.columnCount === result.value.columns.length && cached.rowCount === result.value.rows.length) {
      newRows.value = cached.newRows;
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

  function touchPendingChanges() {
    pendingChangesVersion.value++;
  }

  function pendingChangesSnapshot(): PendingChangesHistorySnapshot {
    return {
      newRows: newRows.value.map((row) => [...row]),
      dirtyRows: new Map([...dirtyRows.value].map(([rowIndex, changes]) => [rowIndex, new Map(changes)])),
      deletedRows: new Set(deletedRows.value),
      transactionActive: transactionActive.value,
    };
  }

  function restorePendingChangesSnapshot(snapshot: PendingChangesHistorySnapshot) {
    newRows.value = snapshot.newRows.map((row) => [...row]);
    dirtyRows.value = new Map([...snapshot.dirtyRows].map(([rowIndex, changes]) => [rowIndex, new Map(changes)]));
    deletedRows.value = new Set(snapshot.deletedRows);
    transactionActive.value = snapshot.transactionActive === true && useTransaction.value === true;
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

  function exitTransaction() {
    transactionActive.value = false;
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

  // --- Inline editing ---
  function startEdit(rowId: number, colIdx: number) {
    if (!editable.value) return;
    if (!canEditColumn(colIdx)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;
    if (!item.isNew && !canEditExistingRows.value) return;
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

  function commitEdit() {
    if (isCancelling || isCommitting) return;
    if (!editingCell.value) return;
    isCommitting = true;
    const { rowId, col } = editingCell.value;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) {
      editingCell.value = null;
      isCommitting = false;
      return;
    }

    if (item.isNew && item.newIndex !== undefined) {
      const oldVal = newRows.value[item.newIndex]?.[col];
      const newVal = coerceCellValue(editValue.value, oldVal, col);
      if (newRows.value[item.newIndex]) {
        if (newVal !== oldVal) pushUndoSnapshot();
        newRows.value[item.newIndex][col] = newVal;
      }
      newRows.value = [...newRows.value];
      touchPendingChanges();
      editingCell.value = null;
      isCommitting = false;
      return;
    }

    if (item.sourceIndex === undefined) {
      editingCell.value = null;
      isCommitting = false;
      return;
    }
    if (!canEditExistingRows.value) {
      editingCell.value = null;
      isCommitting = false;
      return;
    }

    const oldVal = result.value.rows[item.sourceIndex]?.[col];
    const newVal = coerceCellValue(editValue.value, oldVal, col);
    if (newVal !== oldVal) {
      pushUndoSnapshot();
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
    touchPendingChanges();
    editingCell.value = null;
    isCommitting = false;
  }

  function commitEditFromBlur() {
    if (suppressNextBlurCommit) {
      suppressNextBlurCommit = false;
      return;
    }
    commitEdit();
  }

  function applyCellValue(rowId: number, col: number, value: string | null) {
    if (!canEditColumn(col)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;

    if (item.isNew && item.newIndex !== undefined) {
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

    if (item.isNew && item.newIndex !== undefined) {
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
    const isExpandedTextarea = e.target instanceof HTMLTextAreaElement && e.target.dataset.expandedCellEditor === "true";
    if (e.key === "Enter" && (!isExpandedTextarea || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitEdit();
      nextTick(focusScrollerWithoutScrolling);
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

  function applyDeleteRow(rowId: number) {
    const item = getRowItem(rowId);
    if (!item) return;
    if (item.isNew && item.newIndex !== undefined) {
      pushUndoSnapshot();
      newRows.value.splice(item.newIndex, 1);
      newRows.value = [...newRows.value];
    } else if (item.sourceIndex !== undefined) {
      if (!canEditExistingRows.value) return;
      pushUndoSnapshot();
      dirtyRows.value.delete(item.sourceIndex);
      deletedRows.value.add(item.sourceIndex);
      dirtyRows.value = new Map(dirtyRows.value);
      deletedRows.value = new Set(deletedRows.value);
    }
    touchPendingChanges();
    if (editingCell.value?.rowId === rowId) editingCell.value = null;
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
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
      for (const rowId of pendingDeleteRowIds.value) {
        applyDeleteRow(rowId);
      }
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
  function saveStatementOptions() {
    if (!tableMeta.value) return null;
    return {
      databaseType: resolvedDatabaseType.value,
      tableMeta: tableMeta.value,
      columns: result.value.columns,
      sourceColumns: sourceColumns.value,
      rows: result.value.rows,
      dirtyRows: [...dirtyRows.value.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]] as [number, Array<[number, CellValue]>]),
      deletedRows: [...deletedRows.value],
      newRows: newRows.value,
    };
  }

  function tableHistoryTarget() {
    if (!tableMeta.value) return "";
    return [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".");
  }

  function dataChangeOperation() {
    const operations = [newRows.value.length > 0 ? "INSERT" : "", dirtyRows.value.size > 0 ? "UPDATE" : "", deletedRows.value.size > 0 ? "DELETE" : ""].filter(Boolean);
    return operations.length === 1 ? operations[0] : "DATA CHANGE";
  }

  async function recordDataGridHistory(statements: string[], rollbackStatements: string[], elapsed: number, historyResult?: { affected_rows?: number; success?: boolean; error?: string }) {
    if (!connectionId.value || !tableMeta.value) return;
    const connName = connectionStore.getConfig(connectionId.value)?.name || "";
    const success = historyResult?.success ?? true;
    const details = {
      schema: tableMeta.value.schema,
      table: tableMeta.value.tableName,
      inserted_rows: newRows.value.length,
      updated_rows: dirtyRows.value.size,
      deleted_rows: deletedRows.value.size,
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
      operation: dataChangeOperation(),
      target: tableHistoryTarget(),
      affected_rows: success ? (historyResult?.affected_rows ?? statements.length) : undefined,
      rollback_sql: success && rollbackStatements.length ? rollbackStatements.join("\n") : undefined,
      details_json: JSON.stringify(details),
    });
  }

  async function recordFailedDataGridHistory(statements: string[], rollbackStatements: string[], start: number, error: unknown) {
    const message = normalizeDataGridSaveError(resolvedDatabaseType.value, error);
    try {
      await recordDataGridHistory(statements, rollbackStatements, Date.now() - start, {
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

  function applyDirtyRowsToResult() {
    for (const [sourceIndex, changes] of dirtyRows.value) {
      const row = result.value.rows[sourceIndex];
      if (row) {
        for (const [colIdx, value] of changes) {
          row[colIdx] = value;
        }
      }
    }
  }

  async function saveChanges() {
    saveError.value = "";
    isSaving.value = true;
    const shouldReloadAfterSave = newRows.value.length > 0 || deletedRows.value.size > 0;

    if (customSaveHandler?.value) {
      try {
        await customSaveHandler.value.save({
          dirtyRows: dirtyRows.value,
          newRows: newRows.value,
          deletedRows: deletedRows.value,
          columns: result.value.columns,
          rows: result.value.rows,
        });
      } catch (e: any) {
        saveError.value = normalizeDataGridSaveError(resolvedDatabaseType.value, e);
        isSaving.value = false;
        return;
      }
      applyDirtyRowsToResult();
      dirtyRows.value.clear();
      newRows.value = [];
      deletedRows.value.clear();
      clearPendingChangeHistory();
      touchPendingChanges();
      exitTransaction();
      isSaving.value = false;
      if (shouldReloadAfterSave) {
        reloadCurrentData();
      }
      return;
    }

    const stmtOptions = saveStatementOptions();
    let preparedSave: Awaited<ReturnType<typeof api.prepareDataGridSave>> | undefined;
    if (stmtOptions) {
      try {
        preparedSave = await api.prepareDataGridSave(stmtOptions);
      } catch (e: any) {
        saveError.value = normalizeDataGridSaveError(resolvedDatabaseType.value, e);
        isSaving.value = false;
        return;
      }
    }
    if (preparedSave?.validationError) {
      saveError.value = preparedSave.validationError;
      isSaving.value = false;
      return;
    }

    const stmts = preparedSave?.statements ?? [];
    if (stmts.length === 0) {
      isSaving.value = false;
      return;
    }
    const rollbackStmts = preparedSave?.rollbackStatements ?? [];
    const start = Date.now();
    let apiResult: { affected_rows?: number } | undefined;
    console.info("[DBX][dataGrid:save-statements]", {
      databaseType: databaseType.value,
      resolvedDatabaseType: resolvedDatabaseType.value,
      table: tableMeta.value ? [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".") : undefined,
      statements: stmts,
      rollbackStatements: rollbackStmts,
    });

    if (useTransaction.value && hasBackendSaveTarget.value) {
      try {
        apiResult = await api.executeInTransaction(connectionId.value!, database.value ?? "", stmts, preparedSave?.executionSchema);
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, e);
        isSaving.value = false;
        return;
      }
    } else if (hasBackendSaveTarget.value) {
      try {
        apiResult = await api.executeBatch(connectionId.value!, database.value ?? "", stmts, preparedSave?.executionSchema);
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, e);
        isSaving.value = false;
        return;
      }
    } else if (onExecuteSql.value) {
      try {
        for (const sqlStmt of stmts) {
          await onExecuteSql.value(sqlStmt);
        }
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, e);
        isSaving.value = false;
        return;
      }
    }
    try {
      await recordDataGridHistory(stmts, rollbackStmts, Date.now() - start, apiResult);
    } catch (e) {
      console.warn("[DBX] failed to record data grid history", e);
    }
    applyDirtyRowsToResult();
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
    clearPendingChangeHistory();
    touchPendingChanges();
    exitTransaction();
    isSaving.value = false;
    if (shouldReloadAfterSave) {
      reloadCurrentData();
    }
  }

  function discardChanges() {
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
    clearPendingChangeHistory();
    touchPendingChanges();
    editingCell.value = null;
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
    if (!hasPendingChanges.value && !(includeEditing && editingCell.value) && !scroll) {
      pendingChangesCache.delete(k);
      return;
    }
    pendingChangesCache.set(k, {
      newRows: newRows.value.map((r) => [...r]),
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
      saveError.value = normalizeDataGridSaveError(resolvedDatabaseType.value, e);
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
    pendingChangesVersion,
    dirtyRowCount,
    newRowCount,
    deletedRowCount,
    pendingChangeCount,
    hasPendingChanges,
    canUndoPendingChange,
    canRedoPendingChange,
    transactionActive,
    isSaving,
    saveError,
    useTransaction,
    enterTransaction,
    exitTransaction,
    startEdit,
    commitEdit,
    commitEditFromBlur,
    applyCellValue,
    restoreCellValue,
    undoPendingChange,
    redoPendingChange,
    cancelEdit,
    onEditKeydown,
    addRow,
    cloneRow,
    cloneRows,
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
    rowDataWithChanges,
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
    syncHeaderScroll: (headerRef: Ref<HTMLDivElement | undefined>) => (e: Event) => {
      if (headerRef.value) {
        headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
      }
    },
  };
}
