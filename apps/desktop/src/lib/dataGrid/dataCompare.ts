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
  /** Source-side column names aligned positionally with `columns`; needed when the two databases store identifier case differently (e.g. SQL Server vs Oracle). */
  sourceColumns?: string[];
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

/** Minimal column shape a match-column picker needs, so it can be fed straight from `getColumns`. */
export type CompareKeyColumnOption = Pick<ColumnInfo, "name" | "is_primary_key">;

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
export function inferCompareKeyColumns(columns: CompareKeyColumnOption[]): string[] {
  const primaryKeys: string[] = [];
  for (const column of columns) {
    if (column.is_primary_key) primaryKeys.push(column.name);
  }
  return primaryKeys;
}

/**
 * Normalizes a match-column selection: trims entries, drops blanks and removes
 * case-insensitive duplicates while keeping the caller's order.
 *
 * Order is preserved because the backend builds each row key from `keyColumns`
 * in order; a stable order keeps diff keys identical between runs, and it lets a
 * composite primary key keep the column order the table declares.
 */
export function normalizeKeyColumns(columns: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const column of columns) {
    const name = column.trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    if (seen.has(lowerName)) continue;
    seen.add(lowerName);
    normalized.push(name);
  }
  return normalized;
}

/**
 * Compares two match-column selections ignoring order and identifier case.
 * Used to decide whether a manual selection still equals the inferred primary
 * key, in which case it carries no override.
 */
export function sameKeyColumns(a: readonly string[], b: readonly string[]): boolean {
  const normalizedA = normalizeKeyColumns(a);
  const normalizedB = normalizeKeyColumns(b);
  if (normalizedA.length !== normalizedB.length) return false;
  const lowerB = new Set(normalizedB.map((column) => column.toLowerCase()));
  return normalizedA.every((column) => lowerB.has(column.toLowerCase()));
}

export interface CompareColumnIntersection {
  /** Target-side column names, kept in source order. */
  columns: string[];
  /** Source-side names aligned positionally with `columns`. */
  sourceColumns: string[];
}

/**
 * Intersects source and target columns case-insensitively.
 *
 * Databases store identifier case differently (SQL Server keeps the created
 * case, Oracle and Dameng store upper case, PostgreSQL lower case), so a
 * migrated table's columns only match across engines when compared without
 * case. Target names are canonical because sync SQL runs against the target.
 */
export function intersectCompareColumns(sourceColumns: Pick<ColumnInfo, "name">[], targetColumns: Pick<ColumnInfo, "name">[]): CompareColumnIntersection {
  const targetNamesByLowerName = new Map<string, string>();
  for (const column of targetColumns) {
    const lowerName = column.name.toLowerCase();
    if (!targetNamesByLowerName.has(lowerName)) targetNamesByLowerName.set(lowerName, column.name);
  }

  const columns: string[] = [];
  const sourceNames: string[] = [];
  const matched = new Set<string>();
  for (const column of sourceColumns) {
    const lowerName = column.name.toLowerCase();
    const targetName = targetNamesByLowerName.get(lowerName);
    if (targetName === undefined || matched.has(lowerName)) continue;
    matched.add(lowerName);
    columns.push(targetName);
    sourceNames.push(column.name);
  }
  return { columns, sourceColumns: sourceNames };
}

/**
 * Resolves a column name to the matching entry of `columns`, ignoring case.
 * Returns undefined when no column matches.
 */
export function matchColumnNameIgnoreCase(name: string, columns: string[]): string | undefined {
  const lowerName = name.toLowerCase();
  return columns.find((column) => column.toLowerCase() === lowerName);
}
