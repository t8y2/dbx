import type { CellPosition } from "@/lib/dataGrid/gridSelection";

export type DataGridNavigationDirection = "up" | "down" | "left" | "right" | "home" | "end" | "pageUp" | "pageDown" | "docHome" | "docEnd";

export interface DataGridNavigationBounds {
  rowCount: number;
  visibleColumnCount: number;
  /** Rows moved by a single PageUp / PageDown. Defaults to 1 when omitted. */
  pageRowCount?: number;
}

export type DataGridScrollAlignment = "nearest" | "start" | "end";

export interface DataGridRowScrollOptions {
  rowIndex: number;
  rowHeight: number;
  viewportHeight: number;
  currentScrollTop: number;
  alignment: DataGridScrollAlignment;
}

export interface DataGridPageScrollOptions {
  previousRowIndex: number;
  rowIndex: number;
  rowHeight: number;
  currentScrollTop: number;
  maximumScrollTop: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function dataGridNavigationOrigin(position: CellPosition | null, selectionFocus: CellPosition | null, extend: boolean): CellPosition | null {
  return extend ? (selectionFocus ?? position) : position;
}

export function dataGridRowScrollTop(options: DataGridRowScrollOptions): number {
  const rowTop = options.rowIndex * options.rowHeight;
  const rowBottom = rowTop + options.rowHeight;
  if (options.alignment === "start" || rowTop < options.currentScrollTop) return Math.max(0, rowTop);
  if (options.alignment === "end" || rowBottom > options.currentScrollTop + options.viewportHeight) {
    return Math.max(0, rowBottom - options.viewportHeight);
  }
  return options.currentScrollTop;
}

export function dataGridPageScrollTop(options: DataGridPageScrollOptions): number {
  const rowOffset = (options.rowIndex - options.previousRowIndex) * options.rowHeight;
  return clamp(options.currentScrollTop + rowOffset, 0, Math.max(0, options.maximumScrollTop));
}

export function moveDataGridCell(position: CellPosition, rowDelta: number, columnDelta: number, bounds: DataGridNavigationBounds): CellPosition | null {
  if (bounds.rowCount <= 0 || bounds.visibleColumnCount <= 0) return null;
  return {
    rowIndex: clamp(position.rowIndex + rowDelta, 0, bounds.rowCount - 1),
    colIndex: clamp(position.colIndex + columnDelta, 0, bounds.visibleColumnCount - 1),
  };
}

export function navigateDataGridCell(position: CellPosition, direction: DataGridNavigationDirection, bounds: DataGridNavigationBounds): CellPosition | null {
  if (bounds.rowCount <= 0 || bounds.visibleColumnCount <= 0) return null;
  const lastRowIndex = bounds.rowCount - 1;
  const lastColIndex = bounds.visibleColumnCount - 1;
  // PageUp/PageDown step follows the viewport row count, with a one-row floor.
  const pageRowCount = Math.max(1, Math.floor(bounds.pageRowCount ?? 1));
  switch (direction) {
    case "up":
      return moveDataGridCell(position, -1, 0, bounds);
    case "down":
      return moveDataGridCell(position, 1, 0, bounds);
    case "left":
      return moveDataGridCell(position, 0, -1, bounds);
    case "right":
      return moveDataGridCell(position, 0, 1, bounds);
    case "home":
      // First visible column of the current row
      return { rowIndex: position.rowIndex, colIndex: 0 };
    case "end":
      // Last visible column of the current row
      return { rowIndex: position.rowIndex, colIndex: lastColIndex };
    case "pageUp":
      return { rowIndex: clamp(position.rowIndex - pageRowCount, 0, lastRowIndex), colIndex: position.colIndex };
    case "pageDown":
      return { rowIndex: clamp(position.rowIndex + pageRowCount, 0, lastRowIndex), colIndex: position.colIndex };
    case "docHome":
      // First cell of the whole grid (Ctrl/Cmd + Home)
      return { rowIndex: 0, colIndex: 0 };
    case "docEnd":
      // Last cell of the whole grid (Ctrl/Cmd + End)
      return { rowIndex: lastRowIndex, colIndex: lastColIndex };
  }
}
