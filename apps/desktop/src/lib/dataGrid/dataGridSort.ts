export type DataGridSortDirection = "asc" | "desc";
export type DataGridSortMode = "database" | "local";

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

type DataGridCellValue = string | number | boolean | null | undefined;
type DataGridRow = DataGridCellValue[];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortDataGridRows<T extends DataGridRow>(rows: readonly T[], columnIndex: number, direction: DataGridSortDirection): T[] {
  const directionMultiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const emptyCompared = compareEmptyValues(left.row[columnIndex], right.row[columnIndex]);
      if (emptyCompared !== null) return emptyCompared;
      const compared = compareDataGridValues(left.row[columnIndex], right.row[columnIndex]);
      if (compared !== 0) return compared * directionMultiplier;
      return left.index - right.index;
    })
    .map((item) => item.row);
}

export function compareDataGridValues(left: DataGridCellValue, right: DataGridCellValue): number {
  const leftEmpty = left == null;
  const rightEmpty = right == null;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return compareNumbers(left, right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (typeof left === "string" && typeof right === "string") {
    const leftDate = dateSortValue(left);
    const rightDate = dateSortValue(right);
    if (leftDate !== null && rightDate !== null) return compareNumbers(leftDate, rightDate);
    return collator.compare(left, right);
  }

  return collator.compare(String(left), String(right));
}

function compareEmptyValues(left: DataGridCellValue, right: DataGridCellValue): number | null {
  const leftEmpty = left == null;
  const rightEmpty = right == null;
  if (!leftEmpty && !rightEmpty) return null;
  if (leftEmpty && rightEmpty) return 0;
  return leftEmpty ? 1 : -1;
}

function compareNumbers(left: number, right: number): number {
  if (Number.isNaN(left) || Number.isNaN(right)) {
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    return Number.isNaN(left) ? 1 : -1;
  }
  return left - right;
}

function dateSortValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
