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
  // 单遍行扫描 + 候选原地压缩：列一旦见到非 null 即永久剔除，候选清空提前
  // 返回。最坏复杂度同为 O(列×行)（全 null 时无法避免），改进在于常数项：
  // 原实现逐列 rows.every 各自从头扫外层 rows 并逐格调用回调，这里每个
  // 单元格至多访问一次且无闭包调用
  const candidates = [...availableIndexes];
  let count = candidates.length;
  for (const row of rows) {
    let write = 0;
    for (let read = 0; read < count; read++) {
      if (row[candidates[read]!] === null) candidates[write++] = candidates[read]!;
    }
    count = write;
    if (count === 0) return [];
  }
  candidates.length = count;
  return candidates;
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
