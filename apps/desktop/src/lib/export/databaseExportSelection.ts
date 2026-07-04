export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length > 0 && selectedTables.length === allTables.length) {
    return undefined;
  }

  const selected = new Set(selectedTables);
  return allTables.filter((table) => selected.has(table));
}
