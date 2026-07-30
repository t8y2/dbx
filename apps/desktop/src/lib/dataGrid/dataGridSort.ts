export type DataGridSortDirection = "asc" | "desc";
export type DataGridSortMode = "database" | "local";

export interface DataGridSortState {
  column: string | null;
  columnIndex: number | null;
  direction: DataGridSortDirection;
}

interface SimpleDataGridOrderBy {
  column: string;
  direction: DataGridSortDirection;
  quoted: boolean;
}

function parseSimpleDataGridOrderBy(orderBy: string | undefined): SimpleDataGridOrderBy | undefined {
  const match = orderBy?.trim().match(/^((?:n\.)?(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])+\]|[A-Za-z_][A-Za-z0-9_$]*))\s+(?:ASC|DESC)$/i);
  if (!match) return undefined;
  let identifier = match[1]!;
  if (/^n\./i.test(identifier)) identifier = identifier.slice(2);
  const direction = orderBy!.trim().toLocaleLowerCase().endsWith(" desc") ? "desc" : "asc";
  if (identifier.startsWith('"')) return { column: identifier.slice(1, -1).replace(/""/g, '"'), direction, quoted: true };
  if (identifier.startsWith("`")) return { column: identifier.slice(1, -1).replace(/``/g, "`"), direction, quoted: true };
  if (identifier.startsWith("[")) return { column: identifier.slice(1, -1).replace(/\]\]/g, "]"), direction, quoted: true };
  return { column: identifier, direction, quoted: false };
}

function simpleDataGridColumnMatches(orderBy: SimpleDataGridOrderBy, column: string): boolean {
  return orderBy.quoted ? column === orderBy.column : column.toLocaleLowerCase() === orderBy.column.toLocaleLowerCase();
}

export function simpleDataGridOrderByColumn(orderBy: string | undefined): string | undefined {
  return parseSimpleDataGridOrderBy(orderBy)?.column;
}

export function simpleDataGridOrderByReferencesMissingColumn(orderBy: string | undefined, columns: readonly string[]): boolean {
  const parsed = parseSimpleDataGridOrderBy(orderBy);
  if (!parsed) return false;
  return !columns.some((column) => simpleDataGridColumnMatches(parsed, column));
}

export function simpleDataGridOrderByMatchesSort(orderBy: string | undefined, column: string | null | undefined, direction: DataGridSortDirection | null | undefined): boolean {
  if (!column || !direction) return false;
  const parsed = parseSimpleDataGridOrderBy(orderBy);
  return !!parsed && parsed.direction === direction && simpleDataGridColumnMatches(parsed, column);
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
  return sortDataGridRowIndexes(rows, columnIndex, direction).map((index) => rows[index]!);
}

export function sortDataGridRowIndexes(rows: readonly DataGridRow[], columnIndex: number, direction: DataGridSortDirection): number[] {
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
    .map((item) => item.index);
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
