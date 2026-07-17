export function uniqueDataGridColumnOrderKeys(columns: readonly string[], sourceColumns?: readonly (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  return columns.map((column, index) => {
    const base = sourceColumns?.[index] || column || `#${index + 1}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return `${base}\u0000${count}`;
  });
}

export function orderedColumnIndexes(options: { availableIndexes: readonly number[]; columnKeys: readonly string[]; orderedKeys: readonly string[] }): number[] {
  const available = new Set(options.availableIndexes);
  const indexByKey = new Map<string, number>();
  for (const index of options.availableIndexes) {
    const key = options.columnKeys[index];
    if (key) indexByKey.set(key, index);
  }

  const used = new Set<number>();
  const ordered: number[] = [];
  for (const key of options.orderedKeys) {
    const index = indexByKey.get(key);
    if (index === undefined || !available.has(index) || used.has(index)) continue;
    ordered.push(index);
    used.add(index);
  }

  for (const index of options.availableIndexes) {
    if (!used.has(index)) ordered.push(index);
  }

  return ordered;
}

export function moveVisibleColumnIndex(options: { orderedIndexes: readonly number[]; hiddenIndexes: ReadonlySet<number>; fromVisibleIndex: number; toVisibleIndex: number }): number[] {
  const visibleIndexes = options.orderedIndexes.filter((index) => !options.hiddenIndexes.has(index));
  const fromActualIndex = visibleIndexes[options.fromVisibleIndex];
  if (fromActualIndex === undefined) return [...options.orderedIndexes];

  const withoutSource = options.orderedIndexes.filter((index) => index !== fromActualIndex);
  const visibleWithoutSource = visibleIndexes.filter((index) => index !== fromActualIndex);
  const targetVisibleIndex = Math.max(0, Math.min(options.toVisibleIndex, visibleWithoutSource.length));
  if (options.fromVisibleIndex === targetVisibleIndex) return [...options.orderedIndexes];

  const next = [...withoutSource];
  if (targetVisibleIndex >= visibleWithoutSource.length) {
    const lastVisibleIndex = visibleWithoutSource[visibleWithoutSource.length - 1];
    const insertAfterIndex = lastVisibleIndex === undefined ? next.length - 1 : next.indexOf(lastVisibleIndex);
    next.splice(insertAfterIndex + 1, 0, fromActualIndex);
    return next;
  }

  const targetActualIndex = visibleWithoutSource[targetVisibleIndex];
  const insertIndex = targetActualIndex === undefined ? next.length : next.indexOf(targetActualIndex);
  if (insertIndex < 0) return [...options.orderedIndexes];
  next.splice(insertIndex, 0, fromActualIndex);
  return next;
}

export function columnOrderKeysForIndexes(indexes: readonly number[], columnKeys: readonly string[]): string[] {
  return indexes.map((index) => columnKeys[index]).filter((key): key is string => !!key);
}

export function isDefaultColumnOrder(availableIndexes: readonly number[], orderedIndexes: readonly number[]): boolean {
  if (availableIndexes.length !== orderedIndexes.length) return false;
  return availableIndexes.every((index, position) => orderedIndexes[position] === index);
}
