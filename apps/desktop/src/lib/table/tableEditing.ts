import type { ColumnInfo, DatabaseType, IndexInfo } from "@/types/database";
import { getDatabaseCapability } from "@/lib/database/databaseCapabilities";

export const DBX_ROWID_COLUMN = "__DBX_ROWID";
export const DBX_NEO4J_ELEMENT_ID_COLUMN = "__DBX_ELEMENT_ID";
export const DBX_TDENGINE_TBNAME_COLUMN = "tbname";

function isViewTableType(tableType?: string): boolean {
  return tableType?.toUpperCase().includes("VIEW") === true;
}

function isKnownOracleBaseTableType(tableType?: string): boolean {
  return tableType?.trim().toUpperCase() === "TABLE";
}

function isKnownPostgresBaseTableType(tableType?: string): boolean {
  // PostgreSQL reports `relkind = 'r'` through `listTables` as the
  // information-schema spelling `BASE TABLE`; `TABLE` still reaches this from
  // object-browser paths and tests, so both must be accepted.
  const normalized = tableType?.trim().toUpperCase();
  return normalized === "TABLE" || normalized === "BASE TABLE";
}

export function isTdengineStableTableType(tableType?: string): boolean {
  const normalized = tableType?.trim().toUpperCase();
  return normalized === "STABLE" || normalized === "SUPER TABLE" || normalized === "SUPERTABLE";
}

export function editablePrimaryKeys(databaseType: DatabaseType | undefined, columns: ColumnInfo[], tableType?: string): string[] {
  const primaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (isViewTableType(tableType)) return primaryKeys;
  if (databaseType === "tdengine" && primaryKeys.length > 0 && isTdengineStableTableType(tableType)) return [DBX_TDENGINE_TBNAME_COLUMN, ...primaryKeys];
  const syntheticKey = getDatabaseCapability(databaseType).syntheticKey;
  if (syntheticKey === "oracle-rowid" && primaryKeys.length === 0 && isKnownOracleBaseTableType(tableType)) return [DBX_ROWID_COLUMN];
  if (syntheticKey === "xugu-rowid" && primaryKeys.length === 0) return [DBX_ROWID_COLUMN];
  if (syntheticKey === "neo4j-element-id" && primaryKeys.length === 0) return [DBX_NEO4J_ELEMENT_ID_COLUMN];
  return primaryKeys;
}

const UNIQUE_KEY_MODEL_NAME = "UNIQUE KEY";

function isUniqueKeyModelDatabase(databaseType: DatabaseType | undefined): boolean {
  return databaseType === "doris" || databaseType === "starrocks";
}

/** Doris/StarRocks UNIQUE KEY model declaration columns, which may be NULLable. */
function isUniqueKeyModelIndex(index: Pick<IndexInfo, "columns" | "index_type" | "name">): boolean {
  return index.columns.length > 0 && (index.index_type || index.name || "").toUpperCase() === UNIQUE_KEY_MODEL_NAME;
}

/**
 * Whether an index can address exactly one storage row. MySQL-family engines
 * reject NULL in a unique index, so a nullable column makes the set ambiguous.
 * Doris/StarRocks UNIQUE KEY columns are NULLable by design and are still the
 * engine's key, and a table distributed by those columns stores one row per
 * unique key, so NULLs cannot split a row into several.
 */
function indexIdentifiesSingleRow(databaseType: DatabaseType | undefined, index: IndexInfo, columnByName: Map<string, ColumnInfo>): boolean {
  if (index.filter?.trim() || index.columns.length === 0 || (!index.is_primary && !index.is_unique) || index.key_is_expression?.some(Boolean)) return false;
  if (!index.columns.every((name) => columnByName.has(name.toLowerCase()))) return false;
  // A key spanning every projected column leaves nothing to update.
  if (isUniqueKeyModelDatabase(databaseType) && isUniqueKeyModelIndex(index)) return index.columns.length < columnByName.size;
  return index.columns.every((name) => columnByName.get(name.toLowerCase())?.is_nullable === false);
}

/**
 * Doris/StarRocks UNIQUE KEY model columns are the engine's key columns even
 * though they are nullable and are not reported as primary keys. Expose them
 * through `is_unique` so the object browser shows the key affordance while the
 * primary-key flag, and with it schema-generation semantics, stays untouched.
 */
export function uniqueKeyModelColumns(databaseType: DatabaseType | undefined, indexes: readonly IndexInfo[] = []): Set<string> {
  if (!isUniqueKeyModelDatabase(databaseType)) return new Set();
  const uniqueKeyIndex = indexes.find((index) => isUniqueKeyModelIndex(index));
  return new Set((uniqueKeyIndex?.columns ?? []).map((name) => name.toLowerCase()));
}

/** Key columns the engine uses for row identity; no synthetic fallbacks, unlike editable row identifiers. */
export function physicalTablePrimaryKeys(columns: readonly Pick<ColumnInfo, "name" | "is_primary_key">[], indexes: readonly Pick<IndexInfo, "columns" | "is_primary" | "is_unique" | "index_type" | "name">[] = [], databaseType?: DatabaseType): string[] {
  const columnPrimaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (columnPrimaryKeys.length > 0) return columnPrimaryKeys;
  const primaryIndex = indexes.find((index) => index.is_primary && index.columns.length > 0);
  if (primaryIndex) return primaryIndex.columns;
  if (!isUniqueKeyModelDatabase(databaseType)) return [];
  return indexes.find((index) => (index.is_unique || index.is_primary) && isUniqueKeyModelIndex(index))?.columns ?? [];
}

export function editableRowIdentifierColumns(databaseType: DatabaseType | undefined, columns: ColumnInfo[], indexes?: IndexInfo[], tableType?: string): string[] {
  const primaryKeys = editablePrimaryKeys(databaseType, columns, tableType);
  const oracleRowIdFallback = getDatabaseCapability(databaseType).syntheticKey === "oracle-rowid" && primaryKeys.length === 1 && primaryKeys[0]?.toUpperCase() === DBX_ROWID_COLUMN;
  if (primaryKeys.length > 0 && !oracleRowIdFallback) return primaryKeys;
  const columnByName = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const isUniqueKeyModel = isUniqueKeyModelDatabase(databaseType);
  const uniqueIndex = indexes
    ?.filter((index) => indexIdentifiesSingleRow(databaseType, index, columnByName))
    .sort((left, right) => {
      if (isUniqueKeyModel && isUniqueKeyModelIndex(left) !== isUniqueKeyModelIndex(right)) return Number(isUniqueKeyModelIndex(right)) - Number(isUniqueKeyModelIndex(left));
      return Number(right.is_primary) - Number(left.is_primary) || left.columns.length - right.columns.length;
    })[0];
  return uniqueIndex?.columns.map((name) => columnByName.get(name.toLowerCase())?.name ?? name) ?? primaryKeys;
}

export function isTableDataEditable(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  if (isViewTableType(tableType)) return false;
  const cap = getDatabaseCapability(databaseType).tableData;
  if (cap.readonly) return false;
  if (cap.insert) return true;
  return primaryKeys.length > 0;
}

export function canInsertTableRows(databaseType: DatabaseType | undefined): boolean {
  return getDatabaseCapability(databaseType).tableData.insert;
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

/**
 * The toolbar badge warns that updates and deletes fall back to matching every
 * column value, so exact duplicate rows can be changed together. A preview that
 * carries a hidden physical row locator addresses a single row, so showing that
 * warning for it would contradict what the save actually does.
 */
export function showsKeylessEditWarning(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  return canUseKeylessRowPredicate(databaseType, primaryKeys) && !shouldIncludeSyntheticRowId(databaseType, primaryKeys, tableType);
}

export function canEditExistingTableRows(databaseType: DatabaseType | undefined, hiveTableTransactional?: boolean, primaryKeys?: string[]): boolean {
  const tableData = getDatabaseCapability(databaseType).tableData;
  if (tableData.readonly) return false;
  if (tableData.existingRowsReadonly) return false;
  if (tableData.requiresTransactionalTableForExistingRows && hiveTableTransactional !== true) return false;
  if (tableData.updateRequiresPrimaryKey && primaryKeys && primaryKeys.length === 0) return false;
  return true;
}

export function hasCompleteTdengineRowIdentity(databaseType: DatabaseType | undefined, primaryKeys: readonly string[], resultColumns: readonly (string | undefined)[]): boolean {
  if (databaseType !== "tdengine") return true;
  if (primaryKeys.length === 0) return false;
  const availableColumns = new Set(resultColumns.filter((column): column is string => !!column).map((column) => column.toLowerCase()));
  return primaryKeys.every((primaryKey) => availableColumns.has(primaryKey.toLowerCase()));
}

export function canDeleteExistingTdengineRows(databaseType: DatabaseType | undefined, primaryKeys: readonly string[]): boolean {
  if (databaseType !== "tdengine") return true;
  const rowPrimaryKeys = primaryKeys.filter((primaryKey) => primaryKey.toLowerCase() !== DBX_TDENGINE_TBNAME_COLUMN);
  return rowPrimaryKeys.length <= 1;
}

export function hiveTablePropertiesIndicateTransactional(result: { rows: readonly (readonly unknown[])[] }): boolean {
  return result.rows.some((row) => {
    if (row.length === 1)
      return (
        String(row[0] ?? "")
          .trim()
          .toLowerCase() === "true"
      );
    const name = String(row[0] ?? "")
      .trim()
      .toLowerCase();
    const value = String(row[1] ?? "")
      .trim()
      .toLowerCase();
    return name === "transactional" && value === "true";
  });
}

export function usesSyntheticRowIdKey(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  if (isViewTableType(tableType)) return false;
  const syntheticKey = getDatabaseCapability(databaseType).syntheticKey;
  if (primaryKeys.length !== 1) return false;
  if (syntheticKey === "oracle-rowid" || syntheticKey === "xugu-rowid") return primaryKeys[0].toUpperCase() === DBX_ROWID_COLUMN;
  if (syntheticKey === "postgres-ctid") {
    return primaryKeys[0].toUpperCase() === DBX_ROWID_COLUMN && (!tableType || isKnownPostgresBaseTableType(tableType));
  }
  return syntheticKey === "neo4j-element-id" && primaryKeys[0] === DBX_NEO4J_ELEMENT_ID_COLUMN;
}

/** Requests a hidden physical locator only when the backend knows the object type supports it. */
export function shouldIncludeSyntheticRowId(databaseType: DatabaseType | undefined, primaryKeys: string[], tableType?: string): boolean {
  if (isViewTableType(tableType)) return false;
  const syntheticKey = getDatabaseCapability(databaseType).syntheticKey;
  if (syntheticKey === "oracle-rowid" && !isKnownOracleBaseTableType(tableType)) return false;
  if (syntheticKey === "postgres-ctid" && !isKnownPostgresBaseTableType(tableType)) return false;
  if (usesSyntheticRowIdKey(databaseType, primaryKeys, tableType)) return true;
  return (databaseType === "xugu" || syntheticKey === "postgres-ctid") && primaryKeys.length === 0;
}

export function isHiddenGridColumn(databaseType: DatabaseType | undefined, column: string, primaryKeys: string[], tableType?: string): boolean {
  if (databaseType === "neo4j" && column === DBX_NEO4J_ELEMENT_ID_COLUMN) return true;
  if (databaseType === "postgres" && isKnownPostgresBaseTableType(tableType) && column.toUpperCase() === DBX_ROWID_COLUMN) return true;
  // Xugu may inject ROWID before table metadata finishes loading. Keep this
  // internal projection hidden even after the real primary keys arrive.
  if (databaseType === "xugu" && !isViewTableType(tableType) && column.toUpperCase() === DBX_ROWID_COLUMN) return true;
  return shouldIncludeSyntheticRowId(databaseType, primaryKeys, tableType) && column.toUpperCase() === DBX_ROWID_COLUMN;
}

export function isTdengineExistingRowReadonlyColumn(databaseType: DatabaseType | undefined, column: string, columns: ColumnInfo[]): boolean {
  if (databaseType !== "tdengine") return false;
  if (column.toLowerCase() === DBX_TDENGINE_TBNAME_COLUMN) return true;
  const columnInfo = columns.find((info) => info.name.toLowerCase() === column.toLowerCase());
  return !!columnInfo?.is_primary_key || /\btag\b/i.test(columnInfo?.extra ?? "");
}

export function isClickHouseExistingRowReadonlyColumn(databaseType: DatabaseType | undefined, column: string, primaryKeys: readonly string[], columns: ColumnInfo[] = []): boolean {
  if (databaseType !== "clickhouse") return false;
  if (primaryKeys.some((key) => key.toLowerCase() === column.toLowerCase())) return true;
  const columnInfo = columns.find((info) => info.name.toLowerCase() === column.toLowerCase());
  return /\bpartition_key\b/i.test(columnInfo?.extra ?? "");
}

/**
 * Describe flags the Salesforce driver packs into `ColumnInfo.extra`
 * (see `parse_describe_columns` in crates/dbx-drivers/src/db/salesforce_driver.rs).
 * `relationshipName` / `referenceTo` also live there but are consumed by SOQL
 * completion instead (`soqlFieldFromColumnInfo`).
 */
export interface SalesforceColumnFlags {
  updateable?: boolean;
  createable?: boolean;
  custom?: boolean;
  label?: string;
}

export function parseSalesforceColumnExtra(extra?: string | null): SalesforceColumnFlags | null {
  if (!extra) return null;
  try {
    const parsed: unknown = JSON.parse(extra);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SalesforceColumnFlags) : null;
  } catch {
    return null;
  }
}

function findColumnInfoByName(columns: ColumnInfo[], column: string): ColumnInfo | undefined {
  return columns.find((info) => info.name.toLowerCase() === column.toLowerCase());
}

/**
 * Existing Salesforce rows: the record `Id` is the identity and never a write
 * target, and describe reports `updateable: false` for formula, rollup summary,
 * auto-number and system fields (CreatedDate, CreatedById, LastModifiedDate…).
 * Missing/unparseable metadata fails open — Salesforce enforces the real rules
 * server-side and returns a per-record error we surface on the row.
 */
export function isSalesforceExistingRowReadonlyColumn(databaseType: DatabaseType | undefined, column: string, primaryKeys: readonly string[], columns: ColumnInfo[] = []): boolean {
  if (databaseType !== "salesforce") return false;
  if (primaryKeys.some((key) => key.toLowerCase() === column.toLowerCase())) return true;
  return parseSalesforceColumnExtra(findColumnInfoByName(columns, column)?.extra)?.updateable === false;
}

/** New Salesforce rows: fields describe reports as `createable: false` (Id, CreatedDate, …) cannot be set on insert. */
export function isSalesforceNewRowReadonlyColumn(databaseType: DatabaseType | undefined, column: string, columns: ColumnInfo[] = []): boolean {
  if (databaseType !== "salesforce") return false;
  return parseSalesforceColumnExtra(findColumnInfoByName(columns, column)?.extra)?.createable === false;
}
