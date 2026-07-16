import type { CellPosition } from "@/lib/dataGrid/gridSelection";

export type DataGridNavigationDirection = "up" | "down" | "left" | "right" | "home" | "end";

export interface DataGridNavigationBounds {
  rowCount: number;
  visibleColumnCount: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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
      return { rowIndex: position.rowIndex, colIndex: 0 };
    case "end":
      return { rowIndex: position.rowIndex, colIndex: bounds.visibleColumnCount - 1 };
  }
}
