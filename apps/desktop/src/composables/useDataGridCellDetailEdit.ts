import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { cellDetailEditorText, canFormatCellDetailJson, compactJsonText, formatJsonText, looksLikeJsonContainerText, valueEditorActions, type CellDetailTab } from "@/lib/dataGrid/cellDetailPresentation";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";
import { dataGridCellEditorText } from "@/lib/dataGrid/dataGridCellCoercion";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { createJsonValueDiffSnapshot, isJsonValueDiffAvailable, type JsonValueDiffContext, type JsonValueDiffSnapshot } from "@/lib/dataGrid/jsonValueDiff";
import type { ColumnInfo, DatabaseType } from "@/types/database";

interface DetailEditRowItem {
  sourceIndex?: number;
  isNew: boolean;
  isDeleted: boolean;
}

export interface UseDataGridCellDetailEditOptions {
  activeDetail: ComputedRef<DataGridCellDetail | null>;
  activeTab: Ref<CellDetailTab>;
  jsonFormatted: ComputedRef<boolean>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  resultRows: ComputedRef<readonly (readonly CellValue[])[]>;
  getColumnInfo: (columnIndex: number) => ColumnInfo | Pick<ColumnInfo, "data_type"> | undefined;
  getRowItem: (rowId: number) => DetailEditRowItem | undefined;
  hydrateLargeValueCell: (rowId: number, columnIndex: number) => Promise<boolean>;
  applyCellValue: (rowId: number, columnIndex: number, value: string | null) => void;
  restoreCellValue: (rowId: number, columnIndex: number) => void;
  syncEditor: (value: string, columnType?: string) => void;
  refreshDetail: () => void;
  warnFormattedJsonEdit: (detail: DataGridCellDetail, force?: boolean) => void;
}

export function useDataGridCellDetailEdit(options: UseDataGridCellDetailEditOptions) {
  const detailEditValue = ref("");
  const detailEditOriginalValue = ref("");
  const isEditingDetail = ref(false);
  const detailValueDiffOpen = ref(false);
  const detailValueDiffSnapshot = ref<Readonly<JsonValueDiffSnapshot> | null>(null);
  let allowActiveCellDetailResync = false;
  let lastSyncedDetailCellKey: string | null = null;

  const hasPendingDetailEditorDraft = computed(() => isEditingDetail.value && detailEditValue.value !== detailEditOriginalValue.value);
  const detailJsonDiffContext = computed<JsonValueDiffContext | null>(() => {
    const detail = options.activeDetail.value;
    if (!detail) return null;
    return {
      columnName: detail.column,
      columnType: detail.type,
      originalValue: detailEditOriginalValue.value,
      isEditable: detail.isEditable,
      isEditing: isEditingDetail.value,
    };
  });
  const showDetailJsonCompare = computed(() => {
    const context = detailJsonDiffContext.value;
    return !!context && isJsonValueDiffAvailable(context);
  });
  const canCompareDetailJson = computed(() => showDetailJsonCompare.value && hasPendingDetailEditorDraft.value);
  const activeValueEditorActions = computed(() => {
    const detail = options.activeDetail.value;
    return valueEditorActions({
      canSetNull: !!detail?.isEditable && detail.value !== null,
      canFormatJson: !!detail?.isEditable && canFormatCellDetailJson(detail.value, detail.type),
    });
  });

  function editorText(value: CellValue, columnIndex: number): string {
    return dataGridCellEditorText({
      value,
      databaseType: options.databaseType.value,
      columnInfo: options.getColumnInfo(columnIndex),
    });
  }

  function activeDetailEditorText(detail: DataGridCellDetail): string {
    if (options.jsonFormatted.value && detail.formattedJson) return detail.formattedJson;
    return editorText(detail.value, detail.colIndex);
  }

  function resetDetailEdit() {
    isEditingDetail.value = false;
    detailEditValue.value = "";
    detailEditOriginalValue.value = "";
    lastSyncedDetailCellKey = null;
  }

  function syncEditorFromDetailEdit() {
    options.syncEditor(detailEditValue.value, options.activeDetail.value?.type);
  }

  watch(options.activeTab, (tab) => {
    if (tab === "valueEditor") {
      void startDetailEdit();
    } else {
      resetDetailEdit();
    }
  });

  watch(options.activeDetail, (detail) => {
    if (options.activeTab.value !== "valueEditor") return;
    if (!detail?.isEditable) {
      resetDetailEdit();
      return;
    }
    const cellKey = `${detail.rowId}:${detail.colIndex}`;
    const isSameCellStillEditing = isEditingDetail.value && cellKey === lastSyncedDetailCellKey;
    lastSyncedDetailCellKey = cellKey;
    if (isSameCellStillEditing && !allowActiveCellDetailResync) return;
    allowActiveCellDetailResync = false;
    const value = editorText(detail.value, detail.colIndex);
    detailEditValue.value = value;
    detailEditOriginalValue.value = value;
    syncEditorFromDetailEdit();
    isEditingDetail.value = true;
  });

  async function startDetailEdit() {
    const initialDetail = options.activeDetail.value;
    if (!initialDetail || !initialDetail.isEditable) return;
    if (!(await options.hydrateLargeValueCell(initialDetail.rowId, initialDetail.colIndex))) return;
    const detail = options.activeDetail.value;
    if (!detail || !detail.isEditable) return;
    options.warnFormattedJsonEdit(detail);
    const value = activeDetailEditorText(detail);
    detailEditValue.value = value;
    detailEditOriginalValue.value = value;
    isEditingDetail.value = true;
  }

  function commitDetailEdit() {
    const detail = options.activeDetail.value;
    if (!detail || !isEditingDetail.value) return;
    isEditingDetail.value = false;
    const item = options.getRowItem(detail.rowId);
    if (!item || item.isDeleted) return;
    options.applyCellValue(detail.rowId, detail.colIndex, detailEditValue.value);
    detailEditOriginalValue.value = detailEditValue.value;
    allowActiveCellDetailResync = true;
    options.refreshDetail();
  }

  function cancelDetailEdit() {
    resetDetailEdit();
  }

  function cancelValueEditorEdit() {
    const detail = options.activeDetail.value;
    if (!detail || !detail.isEditable) return;
    const value = editorText(detail.value, detail.colIndex);
    detailEditValue.value = value;
    detailEditOriginalValue.value = value;
    syncEditorFromDetailEdit();
    isEditingDetail.value = true;
  }

  function commitValueEditorEdit() {
    commitDetailEdit();
    if (options.activeTab.value === "valueEditor") isEditingDetail.value = true;
  }

  function restoreDetailOriginalValue() {
    const detail = options.activeDetail.value;
    if (!detail || !detail.isEditable) return;
    const item = options.getRowItem(detail.rowId);
    if (!item || item.isDeleted) return;
    let restoredValue: CellValue = null;
    if (!item.isNew && item.sourceIndex !== undefined) {
      restoredValue = options.resultRows.value[item.sourceIndex]?.[detail.colIndex] ?? null;
    }
    options.restoreCellValue(detail.rowId, detail.colIndex);
    const value = editorText(restoredValue, detail.colIndex);
    detailEditValue.value = value;
    detailEditOriginalValue.value = value;
    syncEditorFromDetailEdit();
    isEditingDetail.value = options.activeTab.value === "valueEditor";
    options.refreshDetail();
  }

  function setValueEditorNull() {
    setDetailNull();
    detailEditValue.value = cellDetailEditorText(null);
    detailEditOriginalValue.value = detailEditValue.value;
    syncEditorFromDetailEdit();
    isEditingDetail.value = options.activeTab.value === "valueEditor";
  }

  function formatValueEditorJson() {
    const detail = options.activeDetail.value;
    if (!detail || !canFormatCellDetailJson(detailEditValue.value, detail.type)) return;
    detailEditValue.value = formatJsonText(detailEditValue.value) ?? detailEditValue.value;
    syncEditorFromDetailEdit();
    options.warnFormattedJsonEdit(detail, true);
  }

  function compactDetailJson() {
    const detail = options.activeDetail.value;
    if (!detail || !canFormatCellDetailJson(detailEditValue.value, detail.type)) return;
    detailEditValue.value = compactJsonText(detailEditValue.value) ?? detailEditValue.value;
    syncEditorFromDetailEdit();
  }

  function openDetailJsonCompare() {
    const context = detailJsonDiffContext.value;
    if (!context) return;
    const snapshot = createJsonValueDiffSnapshot({ ...context, currentValue: detailEditValue.value });
    if (!snapshot) return;
    detailValueDiffSnapshot.value = snapshot;
    detailValueDiffOpen.value = true;
  }

  function setDetailNull() {
    const detail = options.activeDetail.value;
    if (!detail || !detail.isEditable) return;
    const item = options.getRowItem(detail.rowId);
    if (!item || item.isDeleted) return;
    options.applyCellValue(detail.rowId, detail.colIndex, null);
    resetDetailEdit();
    options.refreshDetail();
  }

  return {
    detailEditValue,
    detailEditOriginalValue,
    isEditingDetail,
    detailValueDiffOpen,
    detailValueDiffSnapshot,
    hasPendingDetailEditorDraft,
    detailJsonDiffContext,
    showDetailJsonCompare,
    canCompareDetailJson,
    activeValueEditorActions,
    resetDetailEdit,
    syncEditorFromDetailEdit,
    startDetailEdit,
    commitDetailEdit,
    cancelDetailEdit,
    cancelValueEditorEdit,
    commitValueEditorEdit,
    restoreDetailOriginalValue,
    setValueEditorNull,
    formatValueEditorJson,
    compactDetailJson,
    openDetailJsonCompare,
    setDetailNull,
    looksLikeJsonContainerText,
  };
}
