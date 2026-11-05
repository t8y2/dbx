import { createResultKeyLocator } from "./resultKeyLocator";
import * as api from "@/lib/backend/api";
import type { CellValue } from "./cellValue";
import { buildDataGridContextFilterCondition } from "./dataGridSql";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { SnapshotCompletionError } from "@/lib/export/snapshotCompletion";
import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export interface LegacyLargeValueContext {
  databaseType: DatabaseType | undefined;
  connectionId: string | undefined;
  executionDatabase: string;
  tableMeta: { catalog?: string; database?: string; schema?: string; tableName: string; tableType?: string; columns: ColumnInfo[]; primaryKeys: string[] } | undefined;
  sourceColumns: string[];
  rows: CellValue[][];
  rawKeyCells?: QueryResult["raw_key_cells"];
  requiresOriginalKeys?: boolean;
  identifierQuote: string | undefined;
  serverVersion: string | undefined;
  includeDatabaseName: boolean;
  includeRowId: boolean;
  timeoutSecs: number;
}

export interface LegacyLargeValueCellRequest {
  rowId: number;
  sourceIndex: number;
  columnIndex: number;
  originalBytes: number;
}
export type LegacyResolvedLargeValueCells = Map<number, Map<number, CellValue>>;
export interface CapturedLegacyLargeValueExport {
  unavailableReason?: string;
  read?: (signal: AbortSignal) => Promise<LegacyResolvedLargeValueCells>;
}
interface ReaderOptions {
  uuid: () => string;
  translate: (key: string) => string;
  translateBackendError: (error: unknown) => string;
}

export function legacyLargeValueIdentityKey(row: readonly CellValue[], indexes: readonly number[]): string {
  return indexes
    .map((index) => {
      const value = row[index] ?? null;
      return value === null ? "null" : `${typeof value}:${JSON.stringify(value)}`;
    })
    .join("\u001f");
}

export function chunkLegacyLargeValueRequests(requests: LegacyLargeValueCellRequest[], databaseType: DatabaseType | undefined): LegacyLargeValueCellRequest[][] {
  const maxRows = databaseType === "postgres" ? 1 : 200;
  const chunks: LegacyLargeValueCellRequest[][] = [];
  let chunk: LegacyLargeValueCellRequest[] = [];
  let bytes = 0;
  for (const request of requests) {
    if (chunk.length && (chunk.length >= maxRows || bytes + request.originalBytes > 64 * 1024 * 1024)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(request);
    bytes += request.originalBytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function contextKeyLocator(context: LegacyLargeValueContext, indexes: number[], options: ReaderOptions) {
  return createResultKeyLocator({ columns: context.sourceColumns, rows: context.rows, raw_key_cells: context.rawKeyCells, affected_rows: 0, execution_time_ms: 0 }, indexes, context.requiresOriginalKeys === true, options.translate("grid.largeValueOriginalKeyUnavailable"));
}

export async function legacyLargeValueRowPredicate(context: LegacyLargeValueContext, sourceIndex: number, primaryKeyIndexes: number[], options: ReaderOptions): Promise<string> {
  const row = context.rows[sourceIndex];
  if (!row) throw new Error(options.translate("grid.largeValueRowUnavailable"));
  const keyValues = contextKeyLocator(context, primaryKeyIndexes, options).values(sourceIndex);
  return legacyLargeValueKeyPredicate(context, keyValues, options);
}

async function legacyLargeValueKeyPredicate(context: LegacyLargeValueContext, keyValues: CellValue[], options: ReaderOptions): Promise<string> {
  const table = context.tableMeta!;
  const conditions = await Promise.all(
    table.primaryKeys.map((columnName, index) =>
      buildDataGridContextFilterCondition({
        databaseType: context.databaseType,
        identifierQuote: context.identifierQuote,
        columnName,
        columnInfo: table.columns.find((column) => column.name.toLocaleLowerCase() === columnName.toLocaleLowerCase()),
        mode: "equals",
        value: keyValues[index]!,
      }),
    ),
  );
  if (conditions.some((condition) => !condition)) throw new Error(options.translate("grid.largeValueRowUnavailable"));
  return conditions.map((condition) => `(${condition})`).join(" AND ");
}

export async function fetchLegacyLargeValueRequestChunk(context: LegacyLargeValueContext, columnIndex: number, requests: LegacyLargeValueCellRequest[], primaryKeyIndexes: number[], resolved: LegacyResolvedLargeValueCells, options: ReaderOptions, beforeRead?: () => void): Promise<void> {
  const table = context.tableMeta!;
  const sourceColumn = context.sourceColumns[columnIndex];
  if (!sourceColumn) throw new Error(options.translate("grid.largeValueColumnUnavailable"));
  // Reuse one index for the batch instead of rescanning all captured keys for
  // every row's predicate and again for result matching.
  const sourceLocator = contextKeyLocator(context, primaryKeyIndexes, options);
  const predicates = await Promise.all(requests.map((request) => legacyLargeValueKeyPredicate(context, sourceLocator.values(request.sourceIndex), options)));
  const selectedColumns = [...new Set([...table.primaryKeys, sourceColumn])];
  const sql = await buildTableSelectSql({
    databaseType: context.databaseType,
    serverVersion: context.serverVersion,
    identifierQuote: context.identifierQuote,
    database: table.database,
    schema: table.schema,
    tableName: table.tableName,
    tableType: table.tableType,
    catalog: table.catalog,
    columns: selectedColumns,
    includeDatabaseName: context.includeDatabaseName,
    primaryKeys: table.primaryKeys,
    whereInput: predicates.map((predicate) => `(${predicate})`).join(" OR "),
    limit: requests.length,
    offset: 0,
    includeRowId: context.includeRowId,
  });
  beforeRead?.();
  const results = await api
    .executeMulti(context.connectionId!, context.executionDatabase, sql, undefined, options.uuid(), { maxRows: requests.length, fetchSize: requests.length, ...(context.requiresOriginalKeys ? { resultKeyColumns: table.primaryKeys } : {}), timeoutSecs: context.timeoutSecs })
    .catch((error) => {
      if (beforeRead) throw new SnapshotCompletionError("unknown", error instanceof Error ? error.message : String(error));
      throw error;
    });
  const failures = results.filter((result) => result.execution_error);
  if (beforeRead && failures.length) {
    const unknown = failures.find((result) => result.error?.operationOutcome !== "not_started");
    const failed = unknown ?? failures[0]!;
    throw new SnapshotCompletionError(unknown ? "unknown" : "failed", failed.error ? options.translateBackendError(failed.error) : String(failed.rows?.[0]?.[0] ?? options.translate("grid.largeValueLoadFailed")));
  }
  const result = results[0];
  if (!result || result.execution_error) throw new Error(result?.error ? options.translateBackendError(result.error) : String(result?.rows?.[0]?.[0] ?? options.translate("grid.largeValueLoadFailed")));
  const resultIndexes = selectedColumns.map((column) => {
    if (!beforeRead && !context.requiresOriginalKeys) return result.columns.findIndex((name) => name.toLocaleLowerCase() === column.toLocaleLowerCase());
    const exact = result.columns.flatMap((name, index) => (name === column ? [index] : []));
    if (exact.length) return exact.length === 1 ? exact[0]! : -1;
    const folded = result.columns.flatMap((name, index) => (name.toLocaleLowerCase() === column.toLocaleLowerCase() ? [index] : []));
    return folded.length === 1 ? folded[0]! : -1;
  });
  if (resultIndexes.some((index) => index < 0)) throw new Error(options.translate("grid.largeValueColumnUnavailable"));
  const keyIndexes = resultIndexes.slice(0, table.primaryKeys.length);
  const valueIndex = resultIndexes[selectedColumns.indexOf(sourceColumn)]!;
  if ((beforeRead || context.requiresOriginalKeys) && result.large_value_cells?.some((cell) => cell.column_index === valueIndex || keyIndexes.includes(cell.column_index))) throw new Error(options.translate("grid.largeValueLoadFailed"));
  const resultLocator = createResultKeyLocator(result, keyIndexes, context.requiresOriginalKeys === true, options.translate("grid.largeValueOriginalKeyUnavailable"));
  const values = new Map<string, CellValue>();
  for (const [rowIndex, row] of result.rows.entries()) {
    const identity = resultLocator.identity(rowIndex);
    if ((beforeRead || context.requiresOriginalKeys) && values.has(identity)) throw new Error(options.translate("grid.largeValueRowUnavailable"));
    values.set(identity, row[valueIndex] ?? null);
  }
  for (const request of requests) {
    const identity = sourceLocator.identity(request.sourceIndex);
    if (!values.has(identity)) throw new Error(options.translate("grid.largeValueRowUnavailable"));
    const rowValues = resolved.get(request.rowId) ?? new Map<number, CellValue>();
    rowValues.set(columnIndex, values.get(identity) ?? null);
    resolved.set(request.rowId, rowValues);
  }
}

export async function resolveCapturedLegacyLargeValueCells(context: LegacyLargeValueContext, requests: LegacyLargeValueCellRequest[], signal: AbortSignal, options: ReaderOptions, assertCurrent: () => void): Promise<LegacyResolvedLargeValueCells> {
  const resolved: LegacyResolvedLargeValueCells = new Map();
  if (!requests.length) return resolved;
  const check = () => {
    if (signal.aborted) throw new SnapshotCompletionError("cancelled", "Export cancelled");
    assertCurrent();
  };
  try {
    check();
    const keyIndexes =
      context.tableMeta?.primaryKeys.map((name) => {
        const indexes = context.sourceColumns.flatMap((column, index) => (column.toLocaleLowerCase() === name.toLocaleLowerCase() ? [index] : []));
        return context.requiresOriginalKeys && indexes.length !== 1 ? -1 : (indexes[0] ?? -1);
      }) ?? [];
    if (!["mysql", "postgres", "oracle", "db2"].includes(context.databaseType ?? "") || !context.tableMeta?.tableName || !keyIndexes.length || keyIndexes.some((index) => index < 0)) throw new Error(options.translate("grid.largeValueNeedsRowIdentifier"));
    const byColumn = new Map<number, LegacyLargeValueCellRequest[]>();
    for (const request of requests) {
      const column = byColumn.get(request.columnIndex) ?? [];
      column.push(request);
      byColumn.set(request.columnIndex, column);
    }
    for (const [columnIndex, column] of byColumn)
      for (const chunk of chunkLegacyLargeValueRequests(column, context.databaseType)) {
        check();
        await fetchLegacyLargeValueRequestChunk(context, columnIndex, chunk, keyIndexes, resolved, options, check);
        check();
      }
    return resolved;
  } catch (error) {
    if (error instanceof SnapshotCompletionError) throw error;
    throw new SnapshotCompletionError("failed", error instanceof Error ? error.message : String(error));
  }
}
