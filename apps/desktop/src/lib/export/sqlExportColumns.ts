import type { SqlExportColumnSelection } from "@/lib/export/sqlInsertMode";

export function sqlExportColumnChoices(columns: readonly (string | undefined)[]): SqlExportColumnSelection[] {
  const occurrences = new Map<string, number>();
  return columns.flatMap((name, sourceIndex) => {
    if (!name) return [];
    const nameOccurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, nameOccurrence + 1);
    return [{ sourceIndex, name, nameOccurrence }];
  });
}

export function resolveSqlExportColumnIndexes(columns: readonly (string | undefined)[], selectedColumns?: readonly SqlExportColumnSelection[]): number[] {
  if (selectedColumns === undefined) return columns.map((_, index) => index);
  if (!selectedColumns.length) throw new Error("Select at least one column for SQL export.");
  const indexesByName = new Map<string, number[]>();
  columns.forEach((name, index) => {
    if (!name) return;
    const indexes = indexesByName.get(name) ?? [];
    indexes.push(index);
    indexesByName.set(name, indexes);
  });
  const used = new Set<number>();
  return selectedColumns.map((column) => {
    const index = indexesByName.get(column.name)?.[column.nameOccurrence];
    if (index === undefined) throw new Error(`Selected SQL export column was not found: ${column.name}`);
    if (used.has(index)) throw new Error(`SQL export column was selected more than once: ${column.name}`);
    used.add(index);
    return index;
  });
}
