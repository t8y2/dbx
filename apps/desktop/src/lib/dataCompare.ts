import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export type DataCompareCellValue = QueryResult["rows"][number][number];

export interface DataCompareChangedCell {
  column: string;
  source: DataCompareCellValue;
  target: DataCompareCellValue;
}

export interface DataCompareRow {
  key: string;
  keyValues: Record<string, DataCompareCellValue>;
  values: Record<string, DataCompareCellValue>;
}

export interface DataCompareModifiedRow {
  key: string;
  keyValues: Record<string, DataCompareCellValue>;
  sourceValues: Record<string, DataCompareCellValue>;
  targetValues: Record<string, DataCompareCellValue>;
  changes: DataCompareChangedCell[];
}

export interface DataCompareResult {
  added: DataCompareRow[];
  removed: DataCompareRow[];
  modified: DataCompareModifiedRow[];
}

export interface DataComparePreparationOptions {
  tableName: string;
  schema?: string;
  columns: string[];
  keyColumns: string[];
  columnInfo?: ColumnInfo[];
  sourceRows: DataCompareCellValue[][];
  targetRows: DataCompareCellValue[][];
  databaseType?: DatabaseType;
}

export interface DataComparePreparation {
  result: DataCompareResult;
  syncStatements: string[];
  syncSql: string;
}

export interface DataCompareFromTablesOptions {
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  sourceTable: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetTable: string;
  columns: string[];
  keyColumns: string[];
  fetchBatchSize?: number;
}

export interface DataCompareMissingTargetOptions {
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  sourceTable: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetTable: string;
  keyColumns: string[];
  fetchBatchSize?: number;
}

export interface DataCompareFromTablesPreparation extends DataComparePreparation {
  preSyncStatements: string[];
  sourceRowCount: number;
  targetRowCount: number;
  sourceTruncated: boolean;
  targetTruncated: boolean;
}

export interface DataCompareSyncPlanTableOptions {
  tableName: string;
  schema?: string;
  columns: string[];
  keyColumns: string[];
  columnInfo?: ColumnInfo[];
  diff: DataCompareResult;
  databaseType?: DatabaseType;
  preSyncStatements?: string[];
}

export interface DataCompareSyncPlanOptions {
  tables: DataCompareSyncPlanTableOptions[];
}

export interface DataCompareSyncPlan {
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  statementCount: number;
  syncStatements: string[];
  syncSql: string;
}
