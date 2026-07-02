import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/api";

export type GridCellValue = string | number | boolean | null | unknown[] | { [key: string]: unknown };

export interface DataGridTableMeta {
  schema?: string;
  tableName: string;
  primaryKeys: string[];
  columns?: DataGridColumnInfo[];
}

export interface DataGridColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key?: boolean;
  column_default?: string | null;
  extra?: string | null;
}

export interface DataGridSaveStatementOptions {
  databaseType?: DatabaseType;
  tableMeta: DataGridTableMeta;
  columns: string[];
  sourceColumns?: Array<string | undefined>;
  rows: GridCellValue[][];
  dirtyRows: Array<[number, Array<[number, GridCellValue]>]>;
  deletedRows: number[];
  newRows: GridCellValue[][];
}

export interface DataGridCopyUpdateStatementOptions {
  databaseType?: DatabaseType;
  tableMeta: DataGridTableMeta;
  columns: string[];
  sourceColumns?: Array<string | undefined>;
  rows: GridCellValue[][];
}

export interface DataGridCopyInsertStatementOptions {
  databaseType?: DatabaseType;
  tableMeta?: DataGridTableMeta;
  columns: string[];
  sourceColumns?: Array<string | undefined>;
  rows: GridCellValue[][];
  excludePrimaryKeys?: boolean;
}

export type DataGridContextFilterMode = "equals" | "not-equals" | "is-null" | "is-not-null" | "like" | "not-like" | "less-than" | "greater-than";

export interface DataGridContextFilterConditionOptions {
  databaseType?: DatabaseType;
  columnName: string;
  mode: DataGridContextFilterMode;
  value: GridCellValue;
  columnInfo?: DataGridColumnInfo;
}

export interface DataGridColumnValueFilterConditionOptions {
  databaseType?: DatabaseType;
  columnName: string;
  columnInfo?: DataGridColumnInfo;
  rawValue: string;
}

export interface DataGridColumnValuesFilterConditionOptions {
  databaseType?: DatabaseType;
  columnName: string;
  columnInfo?: DataGridColumnInfo;
  values: GridCellValue[];
}

export interface DataGridColumnDistinctValuesSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columnName: string;
  columnInfo?: DataGridColumnInfo;
  whereInput?: string;
  searchValue?: string;
  limit?: number;
  includeCounts?: boolean;
}

export interface DataGridCountSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  whereInput?: string;
}

export interface HiveTablePropertiesSqlOptions {
  schema?: string;
  tableName: string;
  propertyName: string;
}

export function buildDataGridCopyUpdateStatements(options: DataGridCopyUpdateStatementOptions): Promise<string[]> {
  return api.buildDataGridCopyUpdateStatements(options);
}

export function buildDataGridCopyInsertStatement(options: DataGridCopyInsertStatementOptions): Promise<string | undefined> {
  return api.buildDataGridCopyInsertStatement(options);
}

export function buildDataGridContextFilterCondition(options: DataGridContextFilterConditionOptions): Promise<string | undefined> {
  return api.buildDataGridContextFilterCondition(options);
}

export function buildDataGridColumnValueFilterCondition(options: DataGridColumnValueFilterConditionOptions): Promise<string | undefined> {
  return api.buildDataGridColumnValueFilterCondition(options);
}

export function buildDataGridColumnValuesFilterCondition(options: DataGridColumnValuesFilterConditionOptions): Promise<string | undefined> {
  return api.buildDataGridColumnValuesFilterCondition(options);
}

export function buildDataGridColumnDistinctValuesSql(options: DataGridColumnDistinctValuesSqlOptions): Promise<string> {
  return api.buildDataGridColumnDistinctValuesSql(options);
}

export function buildDataGridCountSql(options: DataGridCountSqlOptions): Promise<string> {
  return api.buildDataGridCountSql(options);
}

export function buildHiveTablePropertiesSql(options: HiveTablePropertiesSqlOptions): Promise<string> {
  return api.buildHiveTablePropertiesSql(options);
}

export function normalizeDataGridSaveError(databaseType: DatabaseType | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (databaseType === "hive" && /Attempt to do update or delete|Error 10294/i.test(message)) {
    return "Hive UPDATE/DELETE are not enabled for this table or server. Add rows with INSERT, or enable ACID transactional tables in Hive before editing/deleting existing rows.";
  }
  return message;
}
