export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length > 0 && selectedTables.length === allTables.length && allTables.every((t, i) => selectedTables[i] === t)) {
    return undefined;
  }

  const selected = new Set(selectedTables);
  const filtered = allTables.filter((table) => selected.has(table));
  const nonTables = selectedTables.filter((name) => !allTables.includes(name));
  return [...filtered, ...nonTables];
}

export function isDatabaseExportTableSelectionValid(options: { allTableCount: number; selectedTableCount: number; includeStructure: boolean; includeData: boolean }): boolean {
  if (!options.includeStructure && !options.includeData) return true;
  return options.allTableCount === 0 || options.selectedTableCount > 0;
}
