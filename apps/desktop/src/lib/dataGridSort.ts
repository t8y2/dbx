export type DataGridSortDirection = "asc" | "desc";

export interface DataGridSortState {
  column: string | null;
  columnIndex: number | null;
  direction: DataGridSortDirection;
}

export function nextDataGridSortState(current: DataGridSortState, column: string, columnIndex: number): DataGridSortState {
  if (current.column === column && current.columnIndex === columnIndex) {
    if (current.direction === "asc") {
      return { column, columnIndex, direction: "desc" };
    }
    return { column: null, columnIndex: null, direction: "asc" };
  }
  return { column, columnIndex, direction: "asc" };
}
