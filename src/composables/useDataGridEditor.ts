import { ref, computed, nextTick, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/api";
import {
  buildDataGridRollbackStatements,
  buildDataGridSaveStatements,
  dataGridSaveExecutionSchema,
  validateDataGridSave,
} from "@/lib/dataGridSql";
import { rowStatusFilterAfterAddingRow, type RowStatusFilter } from "@/lib/gridRowStatus";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import type { ColumnInfo, DatabaseType } from "@/types/database";

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
  orderByInput: Ref<string>;
  rowStatusFilter: Ref<RowStatusFilter>;
  initialEditColumn?: ComputedRef<number>;
  getRowItem: (rowId: number) => RowItem | undefined;
  emit: {
    (event: "reload", sql?: string, searchText?: string, whereInput?: string, orderBy?: string): void;
  };
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
    onExecuteSql,
    customSave,
    sql,
    searchText,
    whereFilterInput,
    orderByInput,
    rowStatusFilter,
    initialEditColumn,
    getRowItem,
    emit,
  } = options;

  const editingCell = ref<{ rowId: number; col: number } | null>(null);
  const editValue = ref("");
  const scrollerRef = ref<GridScrollerRef | null>(null);
  const dirtyRows = ref<Map<number, Map<number, CellValue>>>(new Map());
  const newRows = ref<CellValue[][]>([]);
  const deletedRows = ref<Set<number>>(new Set());

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
    () => editable.value && (!!customSave?.value || (!!connectionId.value && !!database.value && !!tableMeta.value)),
  );

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
    return value;
  }

  // --- Row data helpers ---
  function rowDataWithChanges(row: CellValue[], sourceIndex: number): CellValue[] {
    const dirty = dirtyRows.value.get(sourceIndex);
    return row.map((v, colIdx) => (dirty?.has(colIdx) ? dirty.get(colIdx)! : v));
  }

  // --- Inline editing ---
  function startEdit(rowId: number, colIdx: number) {
    if (!editable.value) return;
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;
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
    const item = getRowItem(rowId);
    if (!item || item.isDeleted) return;

    if (item.isNew && item.newIndex !== undefined) {
      const oldVal = newRows.value[item.newIndex]?.[col];
      newRows.value[item.newIndex][col] = value === null ? null : coerceCellValue(value, oldVal);
      newRows.value = [...newRows.value];
      return;
    }

    if (item.sourceIndex === undefined) return;

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

  function applyDeleteRow(rowId: number) {
    const item = getRowItem(rowId);
    if (!item) return;
    if (item.isNew && item.newIndex !== undefined) {
      newRows.value.splice(item.newIndex, 1);
    } else if (item.sourceIndex !== undefined) {
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

  function requestDeleteRow(rowId: number) {
    pendingDeleteRowId.value = rowId;
    showDeleteRowConfirm.value = true;
  }

  function confirmDeleteRow() {
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
    historyResult?: { affected_rows?: number },
  ) {
    if (!connectionId.value || !database.value || !tableMeta.value) return;
    const connName = connectionStore.getConfig(connectionId.value)?.name || "";
    const details = {
      schema: tableMeta.value.schema,
      table: tableMeta.value.tableName,
      inserted_rows: newRows.value.length,
      updated_rows: dirtyRows.value.size,
      deleted_rows: deletedRows.value.size,
      statements,
      rollback_statements: rollbackStatements,
    };
    await historyStore.add({
      connection_id: connectionId.value,
      connection_name: connName,
      database: database.value,
      sql: statements.join("\n"),
      execution_time_ms: elapsed,
      success: true,
      activity_kind: "data_change",
      operation: dataChangeOperation(),
      target: tableHistoryTarget(),
      affected_rows: historyResult?.affected_rows ?? statements.length,
      rollback_sql: rollbackStatements.length ? rollbackStatements.join("\n") : undefined,
      details_json: JSON.stringify(details),
    });
  }

  async function saveChanges() {
    saveError.value = "";
    isSaving.value = true;

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
        saveError.value = String(e.message || e);
        isSaving.value = false;
        return;
      }
      dirtyRows.value.clear();
      newRows.value = [];
      deletedRows.value.clear();
      exitTransaction();
      isSaving.value = false;
      emit(
        "reload",
        sql.value,
        searchText.value,
        whereFilterInput.value.trim() || undefined,
        orderByInput.value.trim() || undefined,
      );
      return;
    }

    const stmtOptions = saveStatementOptions();
    const validationError = stmtOptions
      ? validateDataGridSave({
          databaseType: databaseType.value,
          columns: stmtOptions.columns,
          columnInfo: tableMeta.value?.columns,
          dirtyRows: stmtOptions.dirtyRows,
          newRows: stmtOptions.newRows,
        })
      : undefined;
    if (validationError) {
      saveError.value = validationError;
      isSaving.value = false;
      return;
    }

    const stmts = stmtOptions ? buildDataGridSaveStatements(stmtOptions) : [];
    if (stmts.length === 0) {
      isSaving.value = false;
      return;
    }
    const rollbackStmts = stmtOptions ? buildDataGridRollbackStatements(stmtOptions) : [];
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
          dataGridSaveExecutionSchema(databaseType.value, tableMeta.value),
        );
      } catch (e: any) {
        saveError.value = String(e.message || e);
        isSaving.value = false;
        return;
      }
    } else if (connectionId.value && database.value) {
      try {
        apiResult = await api.executeBatch(connectionId.value, database.value, stmts);
      } catch (e: any) {
        saveError.value = String(e.message || e);
        isSaving.value = false;
        return;
      }
    } else if (onExecuteSql.value) {
      try {
        for (const sqlStmt of stmts) {
          await onExecuteSql.value(sqlStmt);
        }
      } catch (e: any) {
        saveError.value = String(e.message || e);
        isSaving.value = false;
        return;
      }
    }
    try {
      await recordDataGridHistory(stmts, rollbackStmts, Date.now() - start, apiResult);
    } catch (e) {
      console.warn("[DBX] failed to record data grid history", e);
    }
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
    exitTransaction();
    isSaving.value = false;
    emit(
      "reload",
      sql.value,
      searchText.value,
      whereFilterInput.value.trim() || undefined,
      orderByInput.value.trim() || undefined,
    );
  }

  function discardChanges() {
    dirtyRows.value.clear();
    newRows.value = [];
    deletedRows.value.clear();
    editingCell.value = null;
    exitTransaction();
  }

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
    applyDeleteRow,
    showDeleteRowConfirm,
    pendingDeleteRowId,
    requestDeleteRow,
    confirmDeleteRow,
    restoreRow,
    deleteSelectedRow,
    saveChanges,
    discardChanges,
    rowDataWithChanges,
    coerceCellValue,
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
