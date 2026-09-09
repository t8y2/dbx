import type { CellValue } from "./cellValue";

export type SerializedDataGridLocalColumnFilters = Record<string, string[]>;

export type DataGridLocalFilterOption = {
  key: string;
  label: string;
  count: number | null;
  value: CellValue;
};

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
}: {
  rows: readonly TRow[];
  newRows: readonly (readonly CellValue[])[];
  columnIndex: number;
  getRowData: (row: TRow, sourceIndex: number) => readonly CellValue[];
  formatValue: (value: CellValue, columnIndex: number) => string;
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
    addValue(getRowData(row, sourceIndex)[columnIndex] ?? null);
  }
  for (const row of newRows) {
    addValue(row[columnIndex] ?? null);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.value === null && b.value !== null) return -1;
    if (a.value !== null && b.value === null) return 1;
    return a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function restoreDataGridLocalColumnFilters(serialized: SerializedDataGridLocalColumnFilters | undefined, columnCount: number): Record<number, Set<string>> {
  if (!serialized || typeof serialized !== "object") return {};

  const restored: Record<number, Set<string>> = {};
  for (const [columnIndexText, values] of Object.entries(serialized)) {
    const columnIndex = Number(columnIndexText);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount || !Array.isArray(values)) continue;
    const filteredValues = values.filter((value): value is string => typeof value === "string");
    if (filteredValues.length > 0) restored[columnIndex] = new Set(filteredValues);
  }
  return restored;
}

export function serializeDataGridLocalColumnFilters(filters: Record<number, Set<string>>): SerializedDataGridLocalColumnFilters {
  return Object.fromEntries(Object.entries(filters).flatMap(([columnIndex, values]) => (values.size > 0 ? [[columnIndex, [...values]]] : [])));
}
