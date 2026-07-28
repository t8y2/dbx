export type SerializedDataGridLocalColumnFilters = Record<string, string[]>;

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
