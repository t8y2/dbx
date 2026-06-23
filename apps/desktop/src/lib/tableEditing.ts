import type { ColumnInfo, DatabaseType, IndexInfo } from "@/types/database";
import { getDatabaseCapability } from "./databaseCapabilities";

export const DBX_ROWID_COLUMN = "__DBX_ROWID";
export const DBX_NEO4J_ELEMENT_ID_COLUMN = "__DBX_ELEMENT_ID";
export const DBX_TDENGINE_TBNAME_COLUMN = "tbname";

function isViewTableType(tableType?: string): boolean {
  return tableType?.toUpperCase().includes("VIEW") === true;
}

export function editablePrimaryKeys(databaseType: DatabaseType | undefined, columns: ColumnInfo[], tableType?: string): string[] {
  const primaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (isViewTableType(tableType)) return primaryKeys;
  if (databaseType === "tdengine" && primaryKeys.length > 0) return [DBX_TDENGINE_TBNAME_COLUMN, ...primaryKeys];
  const syntheticKey = getDatabaseCapability(databaseType).syntheticKey;
  if (syntheticKey === "oracle-rowid" && primaryKeys.length === 0) return [DBX_ROWID_COLUMN];
  if (syntheticKey === "neo4j-element-id" && primaryKeys.length === 0) return [DBX_NEO4J_ELEMENT_ID_COLUMN];
  return primaryKeys;
}

export function editableRowIdentifierColumns(databaseType: DatabaseType | undefined, columns: ColumnInfo[], indexes?: IndexInfo[], tableType?: string): string[] {
  const primaryKeys = editablePrimaryKeys(databaseType, columns, tableType);
  if (primaryKeys.length > 0) return primaryKeys;
  const uniqueIndex = indexes?.filter((index) => !index.filter && index.columns.length > 0 && (index.is_primary || index.is_unique)).sort((left, right) => Number(right.is_primary) - Number(left.is_primary) || left.columns.length - right.columns.length)[0];
  return uniqueIndex?.columns ?? [];
}

export function isTableDataEditable(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  if (isViewTableType(tableType)) return false;
  const cap = getDatabaseCapability(databaseType).tableData;
  if (cap.readonly) return false;
  if (cap.insert) return true;
  return primaryKeys.length > 0;
}

export function supportsDataGridTransaction(databaseType: DatabaseType | undefined): boolean {
  return getDatabaseCapability(databaseType).tableData.transaction;
}

export function usesKeylessRowPredicate(databaseType: DatabaseType | undefined): boolean {
  return !!getDatabaseCapability(databaseType).tableData.keylessRowPredicate;
}

export function canUseKeylessRowPredicate(databaseType: DatabaseType | undefined, primaryKeys: readonly string[]): boolean {
  return primaryKeys.length === 0 && usesKeylessRowPredicate(databaseType);
}

export function canEditExistingTableRows(databaseType: DatabaseType | undefined, hiveTableTransactional?: boolean, primaryKeys?: string[]): boolean {
  const tableData = getDatabaseCapability(databaseType).tableData;
  if (tableData.readonly) return false;
  if (tableData.existingRowsReadonly) return false;
  if (tableData.requiresTransactionalTableForExistingRows && hiveTableTransactional !== true) return false;
  if (databaseType === "tdengine" && !primaryKeys?.some((key) => key.toLowerCase() === DBX_TDENGINE_TBNAME_COLUMN)) return false;
  if (tableData.updateRequiresPrimaryKey && primaryKeys && primaryKeys.length === 0) return false;
  return true;
}

export function hiveTablePropertiesIndicateTransactional(result: { rows: readonly (readonly unknown[])[] }): boolean {
  return result.rows.some((row) => {
    const name = String(row[0] ?? "")
      .trim()
      .toLowerCase();
    const value = String(row[1] ?? "")
      .trim()
      .toLowerCase();
    return name === "transactional" && value === "true";
  });
}

export function usesSyntheticRowIdKey(databaseType: DatabaseType | undefined, primaryKeys: string[]): boolean {
  return primaryKeys.length === 1 && ((databaseType === "oracle" && primaryKeys[0].toUpperCase() === DBX_ROWID_COLUMN) || (databaseType === "neo4j" && primaryKeys[0] === DBX_NEO4J_ELEMENT_ID_COLUMN));
}

export function isHiddenGridColumn(databaseType: DatabaseType | undefined, column: string, primaryKeys: string[]): boolean {
  if (databaseType === "neo4j" && column === DBX_NEO4J_ELEMENT_ID_COLUMN) return true;
  return usesSyntheticRowIdKey(databaseType, primaryKeys) && column.toUpperCase() === DBX_ROWID_COLUMN;
}

export function isTdengineExistingRowReadonlyColumn(databaseType: DatabaseType | undefined, column: string, columns: ColumnInfo[]): boolean {
  if (databaseType !== "tdengine") return false;
  if (column.toLowerCase() === DBX_TDENGINE_TBNAME_COLUMN) return true;
  const columnInfo = columns.find((info) => info.name.toLowerCase() === column.toLowerCase());
  return !!columnInfo?.is_primary_key || /\btag\b/i.test(columnInfo?.extra ?? "");
}
