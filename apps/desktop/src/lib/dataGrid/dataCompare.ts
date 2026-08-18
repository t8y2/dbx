import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export type DataCompareCellValue = QueryResult["rows"][number][number];

export type SamplingStrategy = "Random" | "ExtremeValues" | "Hybrid";

export interface DegradationThreshold {
  fullCompareMaxRows: number;
  sampleMaxRows: number;
  sampleSize: number;
  extremeSampleCount: number;
}

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
  degradationThreshold?: DegradationThreshold;
  samplingStrategy?: SamplingStrategy;
  enableChecksum?: boolean;
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
  degradationThreshold?: DegradationThreshold;
  samplingStrategy?: SamplingStrategy;
  enableChecksum?: boolean;
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

/**
 * Safely infers the columns to use as comparison keys for a table.
 *
 * Only primary-key columns are trusted: a primary key is unique by
 * definition, so comparing on it can never produce duplicate-key failures.
 * Composite primary keys are returned as-is.
 *
 * When no primary key exists an empty array is returned so the caller can ask
 * the user to pick matching columns explicitly. Falling back to the first
 * column would silently select an arbitrary, possibly non-unique field
 * (category, status, date, ...) and make the whole table comparison fail with
 * an unhelpful duplicate-key error.
 */
export function inferCompareKeyColumns(columns: Pick<ColumnInfo, "name" | "is_primary_key">[]): string[] {
  const primaryKeys: string[] = [];
  for (const column of columns) {
    if (column.is_primary_key) primaryKeys.push(column.name);
  }
  return primaryKeys;
}
