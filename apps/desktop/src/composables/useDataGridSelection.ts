import { ref, computed, type ComputedRef, type Ref } from "vue";
import { allCellsSelectionRange, extractColumnsSelection, extractSelection, isCellInSelection, normalizeSelectionRange, normalizeSelectedColumnIndexes, rowSelectionRange, type CellPosition, type CellSelectionRange, type SelectionData } from "@/lib/gridSelection";

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

export interface UseDataGridSelectionOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<RowItem[]>;
  editingCell: Ref<{ rowId: number; col: number } | null>;
  showTranspose: Ref<boolean>;
  transposeRowIndex: Ref<number | null>;
  gridRef: Ref<HTMLDivElement | undefined>;
}

export function useDataGridSelection(options: UseDataGridSelectionOptions) {
  const { columns, displayItems, editingCell, showTranspose, transposeRowIndex, gridRef } = options;

  const selectionAnchor = ref<CellPosition | null>(null);
  const selectionFocus = ref<CellPosition | null>(null);
  const isSelectingCells = ref(false);

  const selectedRowIds = ref<Set<number>>(new Set());
  const selectedColumnIndexes = ref<Set<number>>(new Set());
  const lastClickedRowIndex = ref<number | null>(null);
  const lastClickedColumnIndex = ref<number | null>(null);
  const hasRowSelection = computed(() => selectedRowIds.value.size > 0);
  const selectedRowCount = computed(() => selectedRowIds.value.size);
  const hasColumnSelection = computed(() => selectedColumnIndexes.value.size > 0);

  const selectedRange = computed<CellSelectionRange | null>(() => {
    if (!selectionAnchor.value || !selectionFocus.value) return null;
    return normalizeSelectionRange(selectionAnchor.value, selectionFocus.value);
  });

  const visibleSelectionRows = computed(() => displayItems.value.map((item) => item.data));

  const selectedCells = computed<SelectionData>(() => {
    if (hasColumnSelection.value) {
      return extractColumnsSelection(columns.value, visibleSelectionRows.value, selectedColumnIndexes.value);
    }
    const range = selectedRange.value;
    if (!range) return { columns: [], rows: [] };
    return extractSelection(columns.value, visibleSelectionRows.value, range);
  });

  const selectedCellCount = computed(() => selectedCells.value.columns.length * selectedCells.value.rows.length);
  const hasCellSelection = computed(() => selectedCellCount.value > 0);

  function clearCellSelection() {
    selectionAnchor.value = null;
    selectionFocus.value = null;
    selectedColumnIndexes.value = new Set();
    isSelectingCells.value = false;
  }

  function clearRowSelection() {
    selectedRowIds.value = new Set();
    lastClickedRowIndex.value = null;
  }

  function selectSingleCell(rowIndex: number, colIndex: number) {
    const cell = { rowIndex, colIndex };
    selectionAnchor.value = cell;
    selectionFocus.value = cell;
  }

  function selectRow(rowIndex: number) {
    const range = rowSelectionRange(rowIndex, columns.value.length);
    if (!range) return;
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
  }

  function selectRows(startRow: number, endRow: number) {
    const range = rowSelectionRange(startRow, columns.value.length, endRow);
    if (!range) return;
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
  }

  function selectColumns(startCol: number, endCol: number, options?: { merge?: boolean }) {
    const normalizedColumns = normalizeSelectedColumnIndexes(Array.from({ length: Math.abs(endCol - startCol) + 1 }, (_, index) => Math.min(startCol, endCol) + index));
    if (normalizedColumns.length === 0 || displayItems.value.length <= 0) return;
    clearRowSelection();
    selectionAnchor.value = null;
    selectionFocus.value = null;
    const next = options?.merge ? new Set(selectedColumnIndexes.value) : new Set<number>();
    normalizedColumns.forEach((index) => next.add(index));
    selectedColumnIndexes.value = next;
    focusGridWithoutScrolling();
  }

  function selectColumn(colIndex: number, event?: MouseEvent) {
    const isShift = Boolean(event?.shiftKey);
    const isMeta = Boolean(event?.metaKey || event?.ctrlKey);
    if (isShift && lastClickedColumnIndex.value !== null) {
      selectColumns(lastClickedColumnIndex.value, colIndex, { merge: hasColumnSelection.value });
    } else if (isMeta) {
      clearRowSelection();
      selectionAnchor.value = null;
      selectionFocus.value = null;
      const next = new Set(selectedColumnIndexes.value);
      if (next.has(colIndex)) {
        next.delete(colIndex);
      } else {
        next.add(colIndex);
      }
      selectedColumnIndexes.value = next;
      focusGridWithoutScrolling();
    } else {
      selectColumns(colIndex, colIndex);
    }
    lastClickedColumnIndex.value = colIndex;
  }

  function selectAllCells() {
    const range = allCellsSelectionRange(displayItems.value.length, columns.value.length);
    if (!range) return;
    clearRowSelection();
    selectedColumnIndexes.value = new Set();
    lastClickedColumnIndex.value = null;
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
    focusGridWithoutScrolling();
  }

  function extendCellSelectionTo(rowIndex: number, colIndex: number) {
    if (!selectionAnchor.value) {
      selectSingleCell(rowIndex, colIndex);
      return;
    }
    selectionFocus.value = { rowIndex, colIndex };
  }

  function handleRowClick(rowIndex: number, rowId: number, event: MouseEvent) {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;

    clearCellSelection();

    if (isMeta) {
      const next = new Set(selectedRowIds.value);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      selectedRowIds.value = next;
      lastClickedRowIndex.value = rowIndex;
    } else if (isShift && lastClickedRowIndex.value !== null) {
      const start = Math.min(lastClickedRowIndex.value, rowIndex);
      const end = Math.max(lastClickedRowIndex.value, rowIndex);
      const next = new Set(selectedRowIds.value);
      for (let i = start; i <= end; i++) {
        const item = displayItems.value[i];
        if (item) next.add(item.id);
      }
      selectedRowIds.value = next;
      selectRows(start, end);
    } else {
      selectedRowIds.value = new Set([rowId]);
      selectRow(rowIndex);
      lastClickedRowIndex.value = rowIndex;
    }
  }

  function finishCellSelection() {
    isSelectingCells.value = false;
    document.removeEventListener("mouseup", finishCellSelection);
  }

  function focusGridWithoutScrolling() {
    gridRef.value?.focus({ preventScroll: true });
  }

  function beginCellSelection(rowIndex: number, colIndex: number, event: MouseEvent) {
    if (event.button !== 0) return;
    if (editingCell.value) return;
    event.preventDefault();
    focusGridWithoutScrolling();
    clearCellSelection();
    selectSingleCell(rowIndex, colIndex);
    isSelectingCells.value = true;
    lastClickedColumnIndex.value = colIndex;
    if (showTranspose.value) transposeRowIndex.value = rowIndex;
    document.addEventListener("mouseup", finishCellSelection);
  }

  function extendCellSelection(rowIndex: number, colIndex: number) {
    if (!isSelectingCells.value || !selectionAnchor.value) return;
    selectionFocus.value = { rowIndex, colIndex };
  }

  function handleDataCellMousedown(rowIndex: number, colIndex: number, _rowId: number, event: MouseEvent) {
    if (event.button !== 0) return;
    if (editingCell.value) return;

    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;

    if (isMeta || isShift) {
      event.preventDefault();
      focusGridWithoutScrolling();
      clearRowSelection();
      if (hasColumnSelection.value) clearCellSelection();
      extendCellSelectionTo(rowIndex, colIndex);
      return;
    }

    clearRowSelection();
    beginCellSelection(rowIndex, colIndex, event);
  }

  function isRowSelected(rowId: number): boolean {
    return selectedRowIds.value.has(rowId);
  }

  function cellIsSelected(rowIndex: number, colIndex: number): boolean {
    if (hasColumnSelection.value) return rowIndex >= 0 && rowIndex < displayItems.value.length && selectedColumnIndexes.value.has(colIndex);
    return isCellInSelection(rowIndex, colIndex, selectedRange.value);
  }

  function columnIsSelected(colIndex: number): boolean {
    if (hasColumnSelection.value) return selectedColumnIndexes.value.has(colIndex);
    const range = selectedRange.value;
    if (!range) return false;
    return range.startCol <= colIndex && range.endCol >= colIndex && range.startRow === 0 && range.endRow >= displayItems.value.length - 1;
  }

  function selectedRangeStart(): CellPosition | null {
    const range = selectedRange.value;
    if (!range) return null;
    return { rowIndex: range.startRow, colIndex: range.startCol };
  }

  return {
    selectionAnchor,
    selectionFocus,
    isSelectingCells,
    selectedRange,
    selectedCells,
    selectedCellCount,
    hasCellSelection,
    clearCellSelection,
    selectSingleCell,
    selectRow,
    selectColumn,
    selectColumns,
    selectAllCells,
    extendCellSelectionTo,
    finishCellSelection,
    beginCellSelection,
    extendCellSelection,
    cellIsSelected,
    columnIsSelected,
    selectedRangeStart,
    selectedRowIds,
    selectedColumnIndexes,
    lastClickedRowIndex,
    hasRowSelection,
    selectedRowCount,
    hasColumnSelection,
    clearRowSelection,
    handleRowClick,
    handleDataCellMousedown,
    isRowSelected,
  };
}
