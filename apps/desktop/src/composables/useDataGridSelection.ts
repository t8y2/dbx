import { ref, computed, getCurrentScope, onScopeDispose, type ComputedRef, type Ref } from "vue";
import { allCellsSelectionRange, extractColumnsSelection, extractSelection, isCellInSelection, normalizeSelectionRange, normalizeSelectedColumnIndexes, rowSelectionRange, type CellPosition, type CellSelectionMatrix, type CellSelectionRange, type SelectionData } from "@/lib/dataGrid/gridSelection";
import type { DataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";

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
  getScrollElement?: () => HTMLElement | null;
  cellFromClientPoint?: (clientX: number, clientY: number) => CellPosition | null;
  runtimeScope?: DataGridRuntimeScope;
}

const AUTO_SCROLL_EDGE_SIZE = 40;
const AUTO_SCROLL_MAX_SPEED = 28;

export function useDataGridSelection(options: UseDataGridSelectionOptions) {
  const { columns, displayItems, editingCell, showTranspose, transposeRowIndex, gridRef, getScrollElement, cellFromClientPoint } = options;

  const selectionAnchor = ref<CellPosition | null>(null);
  const selectionFocus = ref<CellPosition | null>(null);
  const isSelectingCells = ref(false);
  let selectionPointerClientX = 0;
  let selectionPointerClientY = 0;
  let selectionAutoScrollFrame = 0;

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

  function buildCellSelectionMatrix(rowIndexes: number[], columnIndexes: number[]): CellSelectionMatrix | null {
    const normalizedRows = normalizeSelectedColumnIndexes(rowIndexes).filter((index) => index < displayItems.value.length && !displayItems.value[index]?.isDraft);
    const normalizedColumns = normalizeSelectedColumnIndexes(columnIndexes).filter((index) => index < columns.value.length);
    if (normalizedRows.length === 0 || normalizedColumns.length === 0) return null;
    return {
      rowIndexes: normalizedRows,
      columnIndexes: normalizedColumns,
      columns: normalizedColumns.map((index) => columns.value[index]),
      rows: normalizedRows.map((rowIndex) => normalizedColumns.map((columnIndex) => displayItems.value[rowIndex]?.data[columnIndex] ?? null)),
    };
  }

  const selectedCellMatrix = computed<CellSelectionMatrix | null>(() => {
    if (hasColumnSelection.value) {
      return buildCellSelectionMatrix(
        displayItems.value.map((_, index) => index),
        [...selectedColumnIndexes.value],
      );
    }

    if (selectedCellKeys.value.size > 0) {
      const columnsByRow = new Map<number, number[]>();
      for (const key of selectedCellKeys.value) {
        const position = parseCellKey(key);
        if (!position || position.rowIndex >= displayItems.value.length || position.colIndex >= columns.value.length || displayItems.value[position.rowIndex]?.isDraft) continue;
        const selectedColumns = columnsByRow.get(position.rowIndex) ?? [];
        selectedColumns.push(position.colIndex);
        columnsByRow.set(position.rowIndex, selectedColumns);
      }
      const rowIndexes = [...columnsByRow.keys()].sort((a, b) => a - b);
      const columnIndexes = normalizeSelectedColumnIndexes(columnsByRow.get(rowIndexes[0]) ?? []);
      if (rowIndexes.length === 0 || columnIndexes.length === 0) return null;
      const hasConsistentColumns = rowIndexes.every((rowIndex) => {
        const rowColumns = normalizeSelectedColumnIndexes(columnsByRow.get(rowIndex) ?? []);
        return rowColumns.length === columnIndexes.length && rowColumns.every((columnIndex, index) => columnIndex === columnIndexes[index]);
      });
      return hasConsistentColumns ? buildCellSelectionMatrix(rowIndexes, columnIndexes) : null;
    }

    const range = selectedRange.value;
    if (!range) return null;
    return buildCellSelectionMatrix(
      Array.from({ length: range.endRow - range.startRow + 1 }, (_, index) => range.startRow + index),
      Array.from({ length: range.endCol - range.startCol + 1 }, (_, index) => range.startCol + index),
    );
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
      selectContiguousRowIds(next);
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

  function selectContiguousRowIds(rowIds: Set<number>) {
    if (rowIds.size === 0) {
      clearCellSelection();
      return;
    }

    const indexes = displayItems.value.reduce<number[]>((selectedIndexes, item, index) => {
      if (rowIds.has(item.id)) selectedIndexes.push(index);
      return selectedIndexes;
    }, []);
    if (indexes.length !== rowIds.size) {
      clearCellSelection();
      return;
    }

    const start = Math.min(...indexes);
    const end = Math.max(...indexes);
    if (end - start + 1 !== indexes.length) {
      clearCellSelection();
      return;
    }
    selectRows(start, end);
  }

  function finishCellSelection() {
    isSelectingCells.value = false;
    document.removeEventListener("mouseup", finishCellSelection);
    document.removeEventListener("mousemove", handleSelectionPointerMove);
    stopSelectionAutoScroll();
  }

  function stopSelectionAutoScroll() {
    if (!selectionAutoScrollFrame) return;
    cancelAnimationFrame(selectionAutoScrollFrame);
    selectionAutoScrollFrame = 0;
  }

  function selectionScrollVelocity(pointer: number, start: number, end: number): number {
    if (pointer < start + AUTO_SCROLL_EDGE_SIZE) {
      return -AUTO_SCROLL_MAX_SPEED * Math.min(1, (start + AUTO_SCROLL_EDGE_SIZE - pointer) / AUTO_SCROLL_EDGE_SIZE);
    }
    if (pointer > end - AUTO_SCROLL_EDGE_SIZE) {
      return AUTO_SCROLL_MAX_SPEED * Math.min(1, (pointer - (end - AUTO_SCROLL_EDGE_SIZE)) / AUTO_SCROLL_EDGE_SIZE);
    }
    return 0;
  }

  function updateSelectionFromPointer() {
    const cell = cellFromClientPoint?.(selectionPointerClientX, selectionPointerClientY);
    if (cell) extendCellSelection(cell.rowIndex, cell.colIndex);
  }

  function runSelectionAutoScroll() {
    selectionAutoScrollFrame = 0;
    if (!isSelectingCells.value) return;

    const scroller = getScrollElement?.();
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const deltaX = selectionScrollVelocity(selectionPointerClientX, rect.left, rect.right);
    const deltaY = selectionScrollVelocity(selectionPointerClientY, rect.top, rect.bottom);
    const previousLeft = scroller.scrollLeft;
    const previousTop = scroller.scrollTop;

    scroller.scrollLeft += deltaX;
    scroller.scrollTop += deltaY;
    updateSelectionFromPointer();

    if (scroller.scrollLeft !== previousLeft || scroller.scrollTop !== previousTop) {
      selectionAutoScrollFrame = requestAnimationFrame(runSelectionAutoScroll);
    }
  }

  function handleSelectionPointerMove(event: MouseEvent) {
    if (!isSelectingCells.value) return;
    selectionPointerClientX = event.clientX;
    selectionPointerClientY = event.clientY;
    updateSelectionFromPointer();
    if (!selectionAutoScrollFrame) selectionAutoScrollFrame = requestAnimationFrame(runSelectionAutoScroll);
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
    selectionPointerClientX = event.clientX;
    selectionPointerClientY = event.clientY;
    lastClickedColumnIndex.value = colIndex;
    if (showTranspose.value) transposeRowIndex.value = rowIndex;
    document.addEventListener("mouseup", finishCellSelection);
    document.addEventListener("mousemove", handleSelectionPointerMove);
  }

  if (options.runtimeScope) options.runtimeScope.addCleanup(finishCellSelection);
  else if (getCurrentScope()) onScopeDispose(finishCellSelection);

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
    selectedCellMatrix,
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
