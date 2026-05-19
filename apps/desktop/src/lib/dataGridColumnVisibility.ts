export interface ColumnVisibilityOption {
  column: string;
  index: number;
}

export function filterColumnVisibilityOptions(columns: string[], query: string): ColumnVisibilityOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  return columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !normalizedQuery || column.toLowerCase().includes(normalizedQuery));
}

export function visibleColumnIndexesForFilter(
  availableIndexes: number[],
  hiddenIndexes: ReadonlySet<number>,
): number[] {
  const visibleIndexes = availableIndexes.filter((index) => !hiddenIndexes.has(index));
  return visibleIndexes.length > 0 ? visibleIndexes : availableIndexes;
}

export function nextHiddenColumnIndexes(options: {
  columnIndex: number;
  hiddenIndexes: ReadonlySet<number>;
  totalColumns: number;
}): Set<number> {
  const next = new Set(options.hiddenIndexes);
  if (next.has(options.columnIndex)) {
    next.delete(options.columnIndex);
    return next;
  }

  if (options.totalColumns - next.size <= 1) return next;
  next.add(options.columnIndex);
  return next;
}

export function invertedHiddenColumnIndexes(
  availableIndexes: number[],
  hiddenIndexes: ReadonlySet<number>,
): Set<number> {
  const next = new Set(availableIndexes.filter((index) => !hiddenIndexes.has(index)));
  if (next.size === availableIndexes.length && availableIndexes.length > 0) {
    next.delete(availableIndexes[0]);
  }
  return next;
}
