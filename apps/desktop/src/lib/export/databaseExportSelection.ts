export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length > 0 && selectedTables.length === allTables.length) {
    return undefined;
  }

  const selected = new Set(selectedTables);
  return allTables.filter((table) => selected.has(table));
}

export function isDatabaseExportTableSelectionValid(options: { allTableCount: number; selectedTableCount: number; includeStructure: boolean; includeData: boolean }): boolean {
  if (!options.includeStructure && !options.includeData) return true;
  return options.allTableCount === 0 || options.selectedTableCount > 0;
}
