import type { DataGridColumnLayoutOption } from "@/composables/useDataGridColumnLayout";

export const DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT = 28;
export const DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT = 288;
export const DATA_GRID_COLUMN_LAYOUT_VIRTUAL_THRESHOLD = 80;
export const DATA_GRID_COLUMN_LAYOUT_DRAG_THRESHOLD = 5;
const DATA_GRID_COLUMN_LAYOUT_BUFFER_ROWS = 6;

export interface DataGridColumnLayoutHandle {
  visibleColumnCount: number;
  displayableColumnCount: number;
  hiddenColumnCount: number;
  orderedColumnLayoutOptions: readonly DataGridColumnLayoutOption[];
  filteredColumnLayoutOptions: (search: string) => DataGridColumnLayoutOption[];
  toggleColumnVisibility: (columnIndex: number) => void;
  showAllColumns: () => void;
  invertColumnVisibility: () => void;
  hasCustomColumnOrder: boolean;
  moveDisplayableColumn: (fromDisplayableIndex: number, toDisplayableIndex: number) => void;
  resetColumnOrder: () => void;
}

export interface DataGridColumnLayoutVirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export interface DataGridColumnLayoutDropTarget {
  insertionIndex: number;
  toDisplayPosition: number;
}

export function dataGridColumnLayoutDropTarget(options: { clientY: number; listTop: number; scrollTop: number; itemCount: number; fromDisplayPosition: number }): DataGridColumnLayoutDropTarget {
  const itemCount = Math.max(0, options.itemCount);
  const totalHeight = itemCount * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT;
  const relativeY = Math.min(totalHeight, Math.max(0, options.clientY - options.listTop + options.scrollTop));
  const rowIndex = Math.min(Math.max(0, itemCount - 1), Math.floor(relativeY / DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT));
  const offsetInRow = relativeY - rowIndex * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT;
  const insertionIndex = relativeY >= totalHeight || offsetInRow >= DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT / 2 ? Math.min(itemCount, rowIndex + 1) : rowIndex;
  const targetBeforeRemoval = insertionIndex > options.fromDisplayPosition ? insertionIndex - 1 : insertionIndex;
  return {
    insertionIndex,
    toDisplayPosition: Math.min(Math.max(0, itemCount - 1), Math.max(0, targetBeforeRemoval)),
  };
}

export function dataGridColumnLayoutVirtualWindow(options: { itemCount: number; scrollTop: number; viewportHeight?: number }): DataGridColumnLayoutVirtualWindow {
  const itemCount = Math.max(0, options.itemCount);
  const viewportHeight = options.viewportHeight ?? DATA_GRID_COLUMN_LAYOUT_VIEWPORT_HEIGHT;
  const requestedFirstVisibleRow = Math.floor(Math.max(0, options.scrollTop) / DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT);
  const firstVisibleRow = Math.min(Math.max(0, itemCount - 1), requestedFirstVisibleRow);
  const visibleRowCount = Math.ceil(viewportHeight / DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT);
  const start = Math.max(0, firstVisibleRow - DATA_GRID_COLUMN_LAYOUT_BUFFER_ROWS);
  const end = Math.min(itemCount, firstVisibleRow + visibleRowCount + DATA_GRID_COLUMN_LAYOUT_BUFFER_ROWS);
  return {
    start,
    end,
    offsetTop: start * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
    totalHeight: itemCount * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
  };
}
