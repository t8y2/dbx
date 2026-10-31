export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length > 0 && selectedTables.length === allTables.length && allTables.every((t, i) => selectedTables[i] === t)) {
    return undefined;
  }

  const selected = new Set(selectedTables);
  const filtered = allTables.filter((table) => selected.has(table));
  const nonTables = selectedTables.filter((name) => !allTables.includes(name));
  return [...filtered, ...nonTables];
}

/**
 * The `selectedTables` value sent with a database export request.
 *
 * An explicit object selection (the object browser's "export selected") is always
 * sent as-is: the backend treats a missing or empty list as the whole schema, which
 * exported every routine and sequence when only objects were requested (#13940).
 * Otherwise the table selection only matters when tables are exported.
 */
export function databaseExportSelectedTablesRequest(allTables: string[], selectedTables: string[], options: { includeStructure: boolean; includeData: boolean; explicitObjectSelection: boolean }): string[] | undefined {
  if (options.explicitObjectSelection) {
    const selected = new Set(selectedTables);
    return [...allTables.filter((table) => selected.has(table)), ...selectedTables.filter((name) => !allTables.includes(name))];
  }
  if (!options.includeStructure && !options.includeData) return undefined;
  return buildSelectedTablesPayload(allTables, selectedTables);
}

export function isDatabaseExportTableSelectionValid(options: { allTableCount: number; selectedTableCount: number; includeStructure: boolean; includeData: boolean }): boolean {
  if (!options.includeStructure && !options.includeData) return true;
  return options.allTableCount === 0 || options.selectedTableCount > 0;
}
