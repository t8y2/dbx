import { buildDataGridColumnLookupItems, filterDataGridColumnLookupItems } from "./dataGridColumnLookup";

export interface ColumnVisibilityOption {
  column: string;
  comment?: string;
  index: number;
}

export interface ColumnVisibilityFilterOptions {
  sourceColumns?: readonly (string | undefined)[];
  commentByColumn?: ReadonlyMap<string, string>;
}

export function filterColumnVisibilityOptions(columns: readonly string[], query: string, options: ColumnVisibilityFilterOptions = {}): ColumnVisibilityOption[] {
  return filterDataGridColumnLookupItems(
    buildDataGridColumnLookupItems({
      columns,
      sourceColumns: options.sourceColumns,
      commentByColumn: options.commentByColumn,
    }),
    query,
  ).map((item) => ({
    column: item.name,
    ...(item.comment ? { comment: item.comment } : {}),
    index: item.index,
  }));
}

export function visibleColumnIndexesForFilter(availableIndexes: number[], hiddenIndexes: ReadonlySet<number>): number[] {
  const visibleIndexes = availableIndexes.filter((index) => !hiddenIndexes.has(index));
  return visibleIndexes.length > 0 ? visibleIndexes : availableIndexes;
}

export function nextHiddenColumnIndexes(options: { columnIndex: number; hiddenIndexes: ReadonlySet<number>; totalColumns: number }): Set<number> {
  const next = new Set(options.hiddenIndexes);
  if (next.has(options.columnIndex)) {
    next.delete(options.columnIndex);
    return next;
  }

  if (options.totalColumns - next.size <= 1) return next;
  next.add(options.columnIndex);
  return next;
}

export function invertedHiddenColumnIndexes(availableIndexes: number[], hiddenIndexes: ReadonlySet<number>): Set<number> {
  const next = new Set(availableIndexes.filter((index) => !hiddenIndexes.has(index)));
  if (next.size === availableIndexes.length && availableIndexes.length > 0) {
    next.delete(availableIndexes[0]);
  }
  return next;
}

export function allNullColumnIndexes(rows: ReadonlyArray<ReadonlyArray<unknown>>, availableIndexes: number[]): number[] {
  if (rows.length === 0) return [];
  return availableIndexes.filter((index) => rows.every((row) => row[index] === null));
}

export function hiddenColumnIndexesWithAllNullColumns(options: { availableIndexes: number[]; hiddenIndexes: ReadonlySet<number>; allNullIndexes: ReadonlySet<number> }): { hiddenIndexes: Set<number>; autoHiddenIndexes: Set<number> } {
  const next = new Set(options.hiddenIndexes);
  const autoHidden = new Set<number>();
  const available = new Set(options.availableIndexes);

  for (const index of options.allNullIndexes) {
    if (!available.has(index) || next.has(index)) continue;
    next.add(index);
    autoHidden.add(index);
  }

  const hasVisibleColumn = options.availableIndexes.some((index) => !next.has(index));
  if (!hasVisibleColumn && options.availableIndexes.length > 0) {
    const restoredIndex = options.availableIndexes.find((index) => autoHidden.has(index)) ?? options.availableIndexes[0];
    next.delete(restoredIndex);
    autoHidden.delete(restoredIndex);
  }

  return { hiddenIndexes: next, autoHiddenIndexes: autoHidden };
}

export function removeAutoHiddenColumnIndexes(hiddenIndexes: ReadonlySet<number>, autoHiddenIndexes: ReadonlySet<number>): Set<number> {
  const next = new Set(hiddenIndexes);
  for (const index of autoHiddenIndexes) {
    next.delete(index);
  }
  return next;
}
