import type { DatabaseExportSelectedObject } from "@/lib/backend/api";

export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length > 0 && selectedTables.length === allTables.length && allTables.every((t, i) => selectedTables[i] === t)) {
    return undefined;
  }

  const selected = new Set(selectedTables);
  const filtered = allTables.filter((table) => selected.has(table));
  const nonTables = selectedTables.filter((name) => !allTables.includes(name));
  return [...filtered, ...nonTables];
}

const RELATION_OBJECT_TYPES = new Set(["TABLE", "VIEW", "MATERIALIZED_VIEW"]);

/**
 * Splits an object browser selection into the names the dialog's table list can
 * show (in list order) and the objects it cannot, such as routines, sequences,
 * packages and views the list does not include.
 */
export function splitDatabaseExportObjectSelection(objects: DatabaseExportSelectedObject[], allTables: string[]): { tables: string[]; others: DatabaseExportSelectedObject[] } {
  const listed = new Set(allTables);
  const isListed = (object: DatabaseExportSelectedObject) => RELATION_OBJECT_TYPES.has(object.objectType) && listed.has(object.name);
  const tableNames = new Set(objects.filter(isListed).map((object) => object.name));
  return {
    tables: allTables.filter((table) => tableNames.has(table)),
    others: objects.filter((object) => !isListed(object)),
  };
}

/**
 * The `selectedObjects` sent for an object browser selection: the tables still
 * checked in the dialog plus the objects the list cannot show. The backend
 * matches them by type, so a table never selects a routine of the same name,
 * and it rejects an empty list instead of exporting the whole schema (#13940).
 */
export function databaseExportSelectedObjectsRequest(selectedTables: string[], viewNames: ReadonlySet<string>, others: DatabaseExportSelectedObject[]): DatabaseExportSelectedObject[] {
  return [...selectedTables.map((name) => ({ objectType: viewNames.has(name) ? "VIEW" : "TABLE", name })), ...others];
}

export function isDatabaseExportTableSelectionValid(options: { allTableCount: number; selectedTableCount: number; includeStructure: boolean; includeData: boolean }): boolean {
  if (!options.includeStructure && !options.includeData) return true;
  return options.allTableCount === 0 || options.selectedTableCount > 0;
}
