import type { ColumnInfo, DatabaseType } from "@/types/database";

export const DBX_ROWID_COLUMN = "__DBX_ROWID";

export function editablePrimaryKeys(databaseType: DatabaseType | undefined, columns: ColumnInfo[]): string[] {
  const primaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (databaseType === "oracle" && primaryKeys.length === 0) return [DBX_ROWID_COLUMN];
  return primaryKeys;
}

export function usesSyntheticRowIdKey(databaseType: DatabaseType | undefined, primaryKeys: string[]): boolean {
  return databaseType === "oracle" && primaryKeys.length === 1 && primaryKeys[0].toUpperCase() === DBX_ROWID_COLUMN;
}

export function isHiddenGridColumn(
  databaseType: DatabaseType | undefined,
  column: string,
  primaryKeys: string[],
): boolean {
  return usesSyntheticRowIdKey(databaseType, primaryKeys) && column.toUpperCase() === DBX_ROWID_COLUMN;
}
