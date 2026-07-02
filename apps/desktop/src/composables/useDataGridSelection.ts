import { ref, computed, type ComputedRef, type Ref } from "vue";
import { allCellsSelectionRange, extractColumnsSelection, extractSelection, isCellInSelection, normalizeSelectionRange, normalizeSelectedColumnIndexes, rowSelectionRange, type CellPosition, type CellSelectionRange, type SelectionData } from "@/lib/gridSelection";

type CellValue = string | number | boolean | null;

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

  const isSelectingAll = ref(false);
  const selectedCellKeys = ref<Set<string>>(new Set());
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

  const selectedCells = computed<SelectionData>(() => {
    if (hasColumnSelection.value) {
      const rows = displayItems.value.filter((item) => !item.isDraft).map((item) => item.data);
      return extractColumnsSelection(columns.value, rows, selectedColumnIndexes.value);
    }
    if (selectedCellKeys.value.size > 0) {
      const selectableKeys = [...selectedCellKeys.value].filter((key) => {
        const position = parseCellKey(key);
        return !!position && !displayItems.value[position.rowIndex]?.isDraft;
      });
      return extractSelectedCellKeys(
        columns.value,
        displayItems.value.map((item) => item.data),
        selectableKeys,
      );
    }
    const range = selectedRange.value;
    if (!range) return { columns: [], rows: [] };
    const rows = displayItems.value
      .slice(range.startRow, range.endRow + 1)
      .filter((item) => !item.isDraft)
      .map((item) => item.data);
    return extractSelection(columns.value, rows, {
      startRow: 0,
      endRow: rows.length - 1,
      startCol: range.startCol,
      endCol: range.endCol,
    });
  });

  const selectedCellCount = computed(() => selectedCells.value.rows.reduce((count, row) => count + row.length, 0));
  const hasCellSelection = computed(() => selectedCellCount.value > 0);

  function clearCellSelection() {
    selectionAnchor.value = null;
    selectionFocus.value = null;
    selectedCellKeys.value = new Set();
    selectedColumnIndexes.value = new Set();
    isSelectingCells.value = false;
    isSelectingAll.value = false;
  }

  function clearRowSelection() {
    isSelectingAll.value = false;
    selectedRowIds.value = new Set();
    lastClickedRowIndex.value = null;
  }

  function selectSingleCell(rowIndex: number, colIndex: number) {
    const cell = { rowIndex, colIndex };
    selectedCellKeys.value = new Set();
    selectionAnchor.value = cell;
    selectionFocus.value = cell;
  }

  function selectRow(rowIndex: number) {
    const range = rowSelectionRange(rowIndex, columns.value.length);
    if (!range) return;
    selectedCellKeys.value = new Set();
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
  }

  function selectRows(startRow: number, endRow: number) {
    const range = rowSelectionRange(startRow, columns.value.length, endRow);
    if (!range) return;
    selectedCellKeys.value = new Set();
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
  }

  function selectColumns(startCol: number, endCol: number, options?: { merge?: boolean }) {
    const normalizedColumns = normalizeSelectedColumnIndexes(Array.from({ length: Math.abs(endCol - startCol) + 1 }, (_, index) => Math.min(startCol, endCol) + index));
    if (normalizedColumns.length === 0 || displayItems.value.length <= 0) return;
    clearRowSelection();
    selectedCellKeys.value = new Set();
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
      selectedCellKeys.value = new Set();
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
    selectedCellKeys.value = new Set();
    lastClickedColumnIndex.value = null;
    selectionAnchor.value = { rowIndex: range.startRow, colIndex: range.startCol };
    selectionFocus.value = { rowIndex: range.endRow, colIndex: range.endCol };
    isSelectingAll.value = true;
    focusGridWithoutScrolling();
  }

  function extendCellSelectionTo(rowIndex: number, colIndex: number) {
    selectedCellKeys.value = new Set();
    if (!selectionAnchor.value) {
      selectSingleCell(rowIndex, colIndex);
      return;
    }
    selectionFocus.value = { rowIndex, colIndex };
  }

  function toggleCellSelection(rowIndex: number, colIndex: number) {
    const key = cellKey(rowIndex, colIndex);
    const next = selectedCellKeys.value.size > 0 ? new Set(selectedCellKeys.value) : selectedRangeToCellKeys(selectedRange.value);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    selectedCellKeys.value = next;
    selectedColumnIndexes.value = new Set();
    if (next.size > 0) {
      selectionAnchor.value = { rowIndex, colIndex };
      selectionFocus.value = null;
    } else {
      selectionAnchor.value = null;
      selectionFocus.value = null;
    }
    isSelectingCells.value = false;
    isSelectingAll.value = false;
    lastClickedColumnIndex.value = colIndex;
    if (showTranspose.value) transposeRowIndex.value = rowIndex;
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

    if (isMeta) {
      event.preventDefault();
      focusGridWithoutScrolling();
      clearRowSelection();
      toggleCellSelection(rowIndex, colIndex);
      return;
    }

    if (isShift) {
      event.preventDefault();
      focusGridWithoutScrolling();
      clearRowSelection();
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
    if (selectedCellKeys.value.size > 0) return selectedCellKeys.value.has(cellKey(rowIndex, colIndex));
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
    isSelectingAll,
    selectedCellKeys,
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

function cellKey(rowIndex: number, colIndex: number): string {
  return `${rowIndex}:${colIndex}`;
}

function parseCellKey(key: string): CellPosition | null {
  const [row, col] = key.split(":");
  const rowIndex = Number(row);
  const colIndex = Number(col);
  if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex) || rowIndex < 0 || colIndex < 0) return null;
  return { rowIndex, colIndex };
}

function selectedRangeToCellKeys(range: CellSelectionRange | null): Set<string> {
  const keys = new Set<string>();
  if (!range) return keys;
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex++) {
      keys.add(cellKey(rowIndex, colIndex));
    }
  }
  return keys;
}

function extractSelectedCellKeys(columns: readonly string[], rows: readonly CellValue[][], keys: Iterable<string>): SelectionData {
  const positions = [...keys]
    .map(parseCellKey)
    .filter((position): position is CellPosition => !!position && position.rowIndex < rows.length && position.colIndex < columns.length)
    .sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  const selectedColumnIndexes = normalizeSelectedColumnIndexes(positions.map((position) => position.colIndex)).filter((index) => index < columns.length);
  const rowsByIndex = new Map<number, CellValue[]>();

  for (const position of positions) {
    const row = rows[position.rowIndex];
    if (!row) continue;
    const values = rowsByIndex.get(position.rowIndex) ?? [];
    values.push(row[position.colIndex] ?? null);
    rowsByIndex.set(position.rowIndex, values);
  }

  return {
    columns: selectedColumnIndexes.map((index) => columns[index]),
    rows: [...rowsByIndex.values()],
  };
}
