import { ref, computed, nextTick, watch, onBeforeUnmount, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/api";
import { normalizeDataGridSaveError } from "@/lib/dataGridSql";
import { rowStatusFilterAfterAddingRow, type RowStatusFilter } from "@/lib/gridRowStatus";
import { supportsDataGridTransaction } from "@/lib/tableEditing";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import { DBX_NEO4J_ELEMENT_ID_COLUMN, DBX_ROWID_COLUMN } from "@/lib/tableEditing";

type CellValue = string | number | boolean | null;

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
  customSave?: ComputedRef<
    | ((changes: {
        dirtyRows: Map<number, Map<number, CellValue>>;
        newRows: CellValue[][];
        deletedRows: Set<number>;
        columns: string[];
        rows: CellValue[][];
      }) => Promise<void>)
    | undefined
  >;
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
    (
      event: "reload",
      sql?: string,
      searchText?: string,
      whereInput?: string,
      orderBy?: string,
      limit?: number,
      offset?: number,
    ): void;
  };
}

interface PendingChangesSnapshot {
  newRows: CellValue[][];
  dirtyRows: Map<number, Map<number, CellValue>>;
  deletedRows: Set<number>;
  columnCount: number;
}

const pendingChangesCache = new Map<string, PendingChangesSnapshot>();

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
    customSave,
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

  // Restore cached pending changes from a previous instance (e.g. after result eviction + reload)
  const key = cacheKey?.value;
  if (key) {
    const cached = pendingChangesCache.get(key);
    if (cached && cached.columnCount === result.value.columns.length) {
      newRows.value = cached.newRows;
      dirtyRows.value = cached.dirtyRows;
      deletedRows.value = cached.deletedRows;
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

  // --- Transaction state ---
  const transactionActive = ref(false);
  const isSaving = ref(false);
  const saveError = ref("");

  const useTransaction = computed(
    () =>
      editable.value &&
      supportsDataGridTransaction(databaseType.value) &&
      (!!customSave?.value || (!!connectionId.value && !!database.value && !!tableMeta.value)),
  );

  if (hasPendingChanges.value && useTransaction.value) {
    transactionActive.value = true;
  }

  function enterTransaction() {
    transactionActive.value = true;
  }

  function exitTransaction() {
    transactionActive.value = false;
  }

  // --- Scroll helpers ---
  let isCancelling = false;
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
      cancelScrollRestoreFrame = requestAnimationFrame(() => {
        restoreScroll();
        cancelScrollRestoreFrame = requestAnimationFrame(() => {
          restoreScroll();
          cancelScrollRestoreFrame = 0;
          isCancelling = false;
        });
      });
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
  }

  // --- Cell value coercion ---
  function isNull(value: unknown): boolean {
    return value === null;
  }

  function coerceCellValue(value: string, oldVal: CellValue | undefined): CellValue {
    if (value.toUpperCase() === "NULL") return null;
    if (value === "" && isNull(oldVal)) return null;
    if (typeof oldVal === "number") {
      const num = Number(value);
      if (!Number.isNaN(num)) return num;
    }
    if (typeof oldVal === "boolean") {
      return value === "true" || value === "1";
    }
    return normalizeSmartQuotedJsonInput(value);
  }

  function normalizeSmartQuotedJsonInput(value: string): string {
    if (!/[“”]/.test(value)) return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try {
      JSON.parse(value);
      return value;
    } catch {
      // macOS smart punctuation can turn JSON delimiters into Chinese-style quotes.
    }
    const normalized = value.replace(/[“”]/g, '"');
    try {
      JSON.parse(normalized);
      return normalized;
    } catch {
      return value;
    }
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
    editingCell.value = { rowId, col: colIdx };
    const val = item?.data[colIdx] ?? null;
    editValue.value = val === null ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
    nextTick(() => {
      const input = document.querySelector(".cell-edit-input") as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  }

  function commitEdit() {
    if (isCancelling) return;
    if (!editingCell.value) return;
    const { rowId, col } = editingCell.value;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) {
      editingCell.value = null;
      return;
    }

    if (item.isNew && item.newIndex !== undefined) {
      const oldVal = newRows.value[item.newIndex]?.[col];
      const newVal = coerceCellValue(editValue.value, oldVal);
      if (newRows.value[item.newIndex]) {
        newRows.value[item.newIndex][col] = newVal;
      }
      editingCell.value = null;
      return;
    }

    if (item.sourceIndex === undefined) {
      editingCell.value = null;
      return;
    }
    if (!canEditExistingRows.value) {
      editingCell.value = null;
      return;
    }

    const oldVal = result.value.rows[item.sourceIndex]?.[col];
    const newVal = coerceCellValue(editValue.value, oldVal);
    if (newVal !== oldVal) {
      if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
      dirtyRows.value.get(item.sourceIndex)!.set(col, newVal);
      if (useTransaction.value && !transactionActive.value) {
        enterTransaction();
      }
    } else {
      const rowChanges = dirtyRows.value.get(item.sourceIndex);
      rowChanges?.delete(col);
      if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
    }
    editingCell.value = null;
  }

  function applyCellValue(rowId: number, col: number, value: string | null) {
    if (!canEditColumn(col)) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;

    if (item.isNew && item.newIndex !== undefined) {
      const oldVal = newRows.value[item.newIndex]?.[col];
      newRows.value[item.newIndex][col] = value === null ? null : coerceCellValue(value, oldVal);
      newRows.value = [...newRows.value];
      return;
    }

    if (item.sourceIndex === undefined) return;
    if (!canEditExistingRows.value) return;

    const oldVal = result.value.rows[item.sourceIndex]?.[col];
    const newVal = value === null ? null : coerceCellValue(value, oldVal);
    if (newVal !== oldVal) {
      if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
      dirtyRows.value.get(item.sourceIndex)!.set(col, newVal);
      if (useTransaction.value && !transactionActive.value) {
        enterTransaction();
      }
    } else {
      const rowChanges = dirtyRows.value.get(item.sourceIndex);
      rowChanges?.delete(col);
      if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
    }
    dirtyRows.value = new Map(dirtyRows.value);
  }

  function cancelEdit() {
    const restoreScroll = preserveScrollPosition();
    isCancelling = true;
    focusScrollerWithoutScrolling();
    editingCell.value = null;
    restoreScrollAcrossFrames(restoreScroll);
  }

  function onEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
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
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    newRows.value.push(result.value.columns.map(() => null));
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
    const columnInfoByName = new Map(
      (tableMeta.value?.columns ?? []).map((column) => [column.name.toLowerCase(), column]),
    );
    return item.data.map((val, i) => {
      const columnName = result.value.columns[i];
      const columnInfo = columnInfoByName.get(columnName.toLowerCase());
      return shouldClearClonedColumn(columnName, columnInfo) ? null : val;
    });
  }

  function shouldClearClonedColumn(columnName: string, columnInfo: ColumnInfo | undefined): boolean {
    if (databaseType.value === "oracle" && columnName.toUpperCase() === DBX_ROWID_COLUMN) return true;
    if (databaseType.value === "neo4j" && columnName === DBX_NEO4J_ELEMENT_ID_COLUMN) return true;
    const extra = columnInfo?.extra ?? "";
    const columnDefault = columnInfo?.column_default ?? "";
    return (
      /\b(auto_increment|autoincrement|identity|generated)\b/i.test(extra) || /\bnextval\s*\(/i.test(columnDefault)
    );
  }

  function cloneRow(rowId: number) {
    const item = getRowItem(rowId);
    if (!item) return;
    const clonedData = clonedRowData(item);
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    newRows.value.push(clonedData);
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
    rowStatusFilter.value = rowStatusFilterAfterAddingRow(rowStatusFilter.value);
    for (const rowId of rowIds) {
      const item = getRowItem(rowId);
      if (!item) continue;
      const clonedData = clonedRowData(item);
      newRows.value.push(clonedData);
    }
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
  }

  function applyDeleteRow(rowId: number) {
    const item = getRowItem(rowId);
    if (!item) return;
    if (item.isNew && item.newIndex !== undefined) {
      newRows.value.splice(item.newIndex, 1);
    } else if (item.sourceIndex !== undefined) {
      if (!canEditExistingRows.value) return;
      dirtyRows.value.delete(item.sourceIndex);
      deletedRows.value.add(item.sourceIndex);
    }
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
    if (item?.sourceIndex !== undefined) {
      deletedRows.value.delete(item.sourceIndex);
    }
  }

  function restoreRows(rowIds: number[]) {
    for (const rowId of rowIds) {
      restoreRow(rowId);
    }
  }

  function deleteSelectedRow(contextCell: Ref<{ rowId: number; rowIndex: number; col: number } | null>) {
    if (!contextCell.value) return;
    requestDeleteRow(contextCell.value.rowId);
  }

  // --- Save/Discard ---
  function saveStatementOptions() {
    if (!tableMeta.value) return null;
    return {
      databaseType: databaseType.value,
      tableMeta: tableMeta.value,
      columns: result.value.columns,
      sourceColumns: sourceColumns.value,
      rows: result.value.rows,
      dirtyRows: [...dirtyRows.value.entries()].map(
        ([rowIndex, changes]) => [rowIndex, [...changes.entries()]] as [number, Array<[number, CellValue]>],
      ),
      deletedRows: [...deletedRows.value],
      newRows: newRows.value,
    };
  }

  function tableHistoryTarget() {
    if (!tableMeta.value) return "";
    return [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".");
  }

  function dataChangeOperation() {
    const operations = [
      newRows.value.length > 0 ? "INSERT" : "",
      dirtyRows.value.size > 0 ? "UPDATE" : "",
      deletedRows.value.size > 0 ? "DELETE" : "",
    ].filter(Boolean);
    return operations.length === 1 ? operations[0] : "DATA CHANGE";
  }

  async function recordDataGridHistory(
    statements: string[],
    rollbackStatements: string[],
    elapsed: number,
    historyResult?: { affected_rows?: number; success?: boolean; error?: string },
  ) {
    if (!connectionId.value || !database.value || !tableMeta.value) return;
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
      database: database.value,
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

  async function recordFailedDataGridHistory(
    statements: string[],
    rollbackStatements: string[],
    start: number,
    error: unknown,
  ) {
    const message = normalizeDataGridSaveError(databaseType.value, error);
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
    options.emit(
      "reload",
      sql.value,
      searchText.value,
      options.currentWhereInput.value,
      orderByInput.value.trim() || undefined,
      pageSize.value,
      (currentPage.value - 1) * pageSize.value,
    );
  }

  async function saveChanges() {
    saveError.value = "";
    isSaving.value = true;
    const shouldReloadAfterSave = newRows.value.length > 0 || deletedRows.value.size > 0;

    if (customSave?.value) {
      try {
        await customSave.value({
          dirtyRows: dirtyRows.value,
          newRows: newRows.value,
          deletedRows: deletedRows.value,
          columns: result.value.columns,
          rows: result.value.rows,
        });
      } catch (e: any) {
        saveError.value = normalizeDataGridSaveError(databaseType.value, e);
        isSaving.value = false;
        return;
      }
      dirtyRows.value.clear();
      newRows.value = [];
      deletedRows.value.clear();
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
        saveError.value = normalizeDataGridSaveError(databaseType.value, e);
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
      table: tableMeta.value
        ? [tableMeta.value.schema, tableMeta.value.tableName].filter(Boolean).join(".")
        : undefined,
      statements: stmts,
      rollbackStatements: rollbackStmts,
    });

    if (useTransaction.value && connectionId.value && database.value) {
      try {
        apiResult = await api.executeInTransaction(
          connectionId.value,
          database.value,
          stmts,
          preparedSave?.executionSchema,
        );
      } catch (e: any) {
        saveError.value = await recordFailedDataGridHistory(stmts, rollbackStmts, start, e);
        isSaving.value = false;
        return;
      }
    } else if (connectionId.value && database.value) {
      try {
        apiResult = await api.executeBatch(connectionId.value, database.value, stmts);
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
    for (const [sourceIndex, changes] of dirtyRows.value) {
      const row = result.value.rows[sourceIndex];
      if (row) {
        for (const [colIdx, value] of changes) {
          row[colIdx] = value;
        }
      }
    }
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
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
    editingCell.value = null;
    exitTransaction();
  }

  // Pending changes reference rows by sourceIndex. When the result set changes
  // (e.g. different WHERE clause, pagination), stale indices point to wrong rows.
  watch(
    () => result.value.rows,
    () => {
      discardChanges();
    },
  );

  // Save pending changes before the component is destroyed so they can be
  // restored if a new DataGrid instance is created for the same tab
  // (e.g. after result eviction + reload).
  onBeforeUnmount(() => {
    const k = cacheKey?.value;
    if (k && hasPendingChanges.value) {
      pendingChangesCache.set(k, {
        newRows: newRows.value.map((r) => [...r]),
        dirtyRows: new Map([...dirtyRows.value].map(([i, m]) => [i, new Map(m)])),
        deletedRows: new Set(deletedRows.value),
        columnCount: result.value.columns.length,
      });
    }
  });

  return {
    editingCell,
    editValue,
    scrollerRef,
    dirtyRows,
    newRows,
    deletedRows,
    dirtyRowCount,
    newRowCount,
    deletedRowCount,
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
    applyCellValue,
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
    syncHeaderScroll: (headerRef: Ref<HTMLDivElement | undefined>) => (e: Event) => {
      if (headerRef.value) {
        headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
      }
    },
  };
}
