import type { CellValue } from "./cellValue";

export type SerializedDataGridLocalColumnFilters = Record<string, string[]>;

export type DataGridLocalFilterOption = {
  key: string;
  label: string;
  count: number | null;
  value: CellValue;
};

export type DataGridLocalFilterSort = {
  field: "value" | "count";
  direction: "asc" | "desc";
};

export type DataGridLocalFilterCountPredicate = (count: number | null) => boolean;

function createCountPredicate(operator: string, target: number): DataGridLocalFilterCountPredicate {
  switch (operator) {
    case ">":
      return (count) => (count ?? 0) > target;
    case ">=":
      return (count) => (count ?? 0) >= target;
    case "<":
      return (count) => (count ?? 0) < target;
    case "<=":
      return (count) => (count ?? 0) <= target;
    case "!=":
    case "<>":
      return (count) => (count ?? 0) !== target;
    case "=":
    case "==":
    default:
      return (count) => (count ?? 0) === target;
  }
}

export function parseDataGridLocalFilterCountQuery(query: string): DataGridLocalFilterCountPredicate | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const prefixMatch = /^(?:count|数量)\s*(?::\s*|\s*=\s*|\s*)?(>=|<=|>|<|==|=|!=|<>)?\s*(\d+)$/i.exec(trimmed);
  if (prefixMatch) {
    const op = prefixMatch[1] ?? "=";
    const target = Number(prefixMatch[2]);
    return createCountPredicate(op, target);
  }

  const opMatch = /^(>=|<=|>|<|==|=|!=|<>)\s*(\d+)$/.exec(trimmed);
  if (opMatch) {
    const op = opMatch[1];
    const target = Number(opMatch[2]);
    return createCountPredicate(op, target);
  }

  return null;
}

export function filterDataGridLocalFilterOptions(options: readonly DataGridLocalFilterOption[], query: string): DataGridLocalFilterOption[] {
  const trimmed = query.trim();
  if (!trimmed) return [...options];

  const countPredicate = parseDataGridLocalFilterCountQuery(trimmed);
  const normalizedQuery = trimmed.toLowerCase();

  return options.filter((option) => {
    if (countPredicate && countPredicate(option.count)) return true;
    return option.label.toLowerCase().includes(normalizedQuery);
  });
}

function compareLocalFilterValues(a: DataGridLocalFilterOption, b: DataGridLocalFilterOption): number {
  if (a.value === null && b.value !== null) return -1;
  if (a.value !== null && b.value === null) return 1;
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
}

export function sortDataGridLocalFilterOptions(options: readonly DataGridLocalFilterOption[], sort: DataGridLocalFilterSort): DataGridLocalFilterOption[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...options].sort((a, b) => {
    if (sort.field === "count") {
      return ((a.count ?? 0) - (b.count ?? 0)) * direction || compareLocalFilterValues(a, b);
    }
    return compareLocalFilterValues(a, b) * direction;
  });
}

export function dataGridLocalFilterKey(value: CellValue): string {
  if (value === null) return "__dbx_null__";
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number") return `num:${value}`;
  return `str:${String(value)}`;
}

export function dataGridLocalFilterLabel(value: CellValue, columnIndex: number, formatValue: (value: CellValue, columnIndex: number) => string): string {
  return value === null ? "NULL" : formatValue(value, columnIndex);
}

export function rowMatchesDataGridLocalColumnFilters(data: readonly CellValue[], filters: Readonly<Record<number, ReadonlySet<string>>>): boolean {
  const activeEntries = Object.entries(filters).filter(([, selected]) => selected.size > 0);
  if (activeEntries.length === 0) return true;
  return activeEntries.every(([columnIndex, selected]) => selected.has(dataGridLocalFilterKey(data[Number(columnIndex)] ?? null)));
}

export function buildDataGridLocalFilterOptions<TRow>({
  rows,
  newRows,
  columnIndex,
  getRowData,
  formatValue,
  includeRow,
  includeNewRow,
}: {
  rows: readonly TRow[];
  newRows: readonly (readonly CellValue[])[];
  columnIndex: number;
  getRowData: (row: TRow, sourceIndex: number) => readonly CellValue[];
  formatValue: (value: CellValue, columnIndex: number) => string;
  includeRow?: (row: TRow, sourceIndex: number) => boolean;
  includeNewRow?: (row: readonly CellValue[]) => boolean;
}): DataGridLocalFilterOption[] {
  const byKey = new Map<string, DataGridLocalFilterOption>();
  const addValue = (value: CellValue) => {
    const key = dataGridLocalFilterKey(value);
    const current = byKey.get(key);
    if (current) {
      current.count = (current.count ?? 0) + 1;
    } else {
      byKey.set(key, {
        key,
        label: dataGridLocalFilterLabel(value, columnIndex, formatValue),
        count: 1,
        value,
      });
    }
  };

  for (const [sourceIndex, row] of rows.entries()) {
    if (includeRow && !includeRow(row, sourceIndex)) continue;
    addValue(getRowData(row, sourceIndex)[columnIndex] ?? null);
  }
  for (const row of newRows) {
    if (includeNewRow && !includeNewRow(row)) continue;
    addValue(row[columnIndex] ?? null);
  }

  return sortDataGridLocalFilterOptions([...byKey.values()], { field: "value", direction: "asc" });
}

export function restoreDataGridLocalColumnFilters(serialized: SerializedDataGridLocalColumnFilters | undefined, columnCount: number, currentColumns?: readonly string[], serializedColumns?: readonly string[]): Record<number, Set<string>> {
  if (!serialized || typeof serialized !== "object") return {};

  const restored: Record<number, Set<string>> = {};
  for (const [serializedColumnIndexText, values] of Object.entries(serialized)) {
    const serializedColumnIndex = Number(serializedColumnIndexText);
    if (!Number.isInteger(serializedColumnIndex) || serializedColumnIndex < 0 || !Array.isArray(values)) continue;
    const columnIndex = currentColumns && serializedColumns ? currentColumns.indexOf(serializedColumns[serializedColumnIndex] ?? "") : serializedColumnIndex;
    if (columnIndex < 0 || columnIndex >= columnCount) continue;
    const filteredValues = values.filter((value): value is string => typeof value === "string");
    if (filteredValues.length > 0) restored[columnIndex] = new Set(filteredValues);
  }
  return restored;
}

export function serializeDataGridLocalColumnFilters(filters: Record<number, Set<string>>): SerializedDataGridLocalColumnFilters {
  return Object.fromEntries(Object.entries(filters).flatMap(([columnIndex, values]) => (values.size > 0 ? [[columnIndex, [...values]]] : [])));
}
