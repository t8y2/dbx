import { reactive, shallowReactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { openDataCompareSession } from "@/composables/useDialogSources";
import { useExportTracker } from "@/composables/useExportTracker";
import { inferCompareKeyColumns, intersectCompareColumns, matchColumnNameIgnoreCase, type DataCompareCellValue, type DataCompareFromTablesPreparation, type DataCompareResult, type DataCompareSyncPlan, type DataCompareSyncPlanTableOptions } from "@/lib/dataGrid/dataCompare";
import type { ColumnInfo, DatabaseType } from "@/types/database";

export type CompareColumn = ColumnInfo;

export interface DataCompareTableTask {
  sourceTable: string;
  targetTable: string;
}

export type DataCompareTableStatus = "different" | "same" | "error";
export type DiffKind = "added" | "removed" | "modified";

export interface SelectableDataCompareRow {
  key: string;
  keyValues: Record<string, DataCompareCellValue>;
  values: Record<string, DataCompareCellValue>;
  selected: boolean;
}

export interface SelectableDataCompareModifiedRow {
  key: string;
  keyValues: Record<string, DataCompareCellValue>;
  sourceValues: Record<string, DataCompareCellValue>;
  targetValues: Record<string, DataCompareCellValue>;
  changes: { column: string; source: DataCompareCellValue; target: DataCompareCellValue }[];
  selected: boolean;
}

export interface SelectableDataCompareResult {
  added: SelectableDataCompareRow[];
  removed: SelectableDataCompareRow[];
  modified: SelectableDataCompareModifiedRow[];
}

export interface DataCompareTableResult {
  sourceTable: string;
  targetTable: string;
  keyColumns: string[];
  columns: string[];
  columnInfo: CompareColumn[];
  status: DataCompareTableStatus;
  added: number;
  removed: number;
  modified: number;
  sourceRowCount: number;
  targetRowCount: number;
  sourceTruncated: boolean;
  targetTruncated: boolean;
  databaseType?: DatabaseType;
  preSyncStatements?: string[];
  diff: SelectableDataCompareResult;
  expanded: boolean;
  showAll: Record<DiffKind, boolean>;
  error?: string;
}

export interface DataCompareSessionConfig {
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  sourceDatabases: string[];
  sourceSchemas: string[];
  sourceTables: string[];
  selectedSourceTables: string[];
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetDatabases: string[];
  targetSchemas: string[];
  targetTables: string[];
  targetTable: string;
  keyColumns: string[];
  label: string;
}

export interface DataCompareSessionProgress {
  current: number;
  total: number;
  table: string;
}

export type DataCompareSessionStatus = "running" | "completed" | "failed";
export type DataCompareSessionErrorKind = "noKeyColumns" | "missingKeyColumns" | "noCommonColumns";

export interface DataCompareSession {
  id: string;
  version: number;
  status: DataCompareSessionStatus;
  config: DataCompareSessionConfig;
  progress: DataCompareSessionProgress | null;
  batchResults: DataCompareTableResult[];
  syncPlan: DataCompareSyncPlan;
  error: string | null;
  startedAt: number;
  finishedAt?: number;
}

export interface DataCompareSessionDependencies {
  ensureConnected(connectionId: string): Promise<unknown>;
  getConfig(connectionId: string): { db_type?: DatabaseType } | undefined;
  formatError?: (kind: DataCompareSessionErrorKind, columns?: string) => string;
}

const sessions = reactive(new Map<string, DataCompareSession>());

export function emptyDataCompareSyncPlan(): DataCompareSyncPlan {
  return {
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    statementCount: 0,
    syncStatements: [],
    syncSql: "",
  };
}

function cloneConfig(config: DataCompareSessionConfig): DataCompareSessionConfig {
  return {
    ...config,
    sourceDatabases: [...config.sourceDatabases],
    sourceSchemas: [...config.sourceSchemas],
    sourceTables: [...config.sourceTables],
    selectedSourceTables: [...config.selectedSourceTables],
    targetDatabases: [...config.targetDatabases],
    targetSchemas: [...config.targetSchemas],
    targetTables: [...config.targetTables],
    keyColumns: [...config.keyColumns],
  };
}

function sessionError(error: unknown): string {
  return error instanceof Error ? error.message : (error as { message?: string } | null)?.message || String(error);
}

function compareErrorMessage(dependencies: DataCompareSessionDependencies, kind: DataCompareSessionErrorKind, columns?: string): string {
  return dependencies.formatError?.(kind, columns) ?? (kind === "missingKeyColumns" ? `Missing key columns: ${columns ?? ""}` : kind === "noCommonColumns" ? "No common columns" : "No key columns available");
}

function toSelectableDiff(diff: DataCompareResult): SelectableDataCompareResult {
  return {
    added: diff.added.map((row) => ({ ...row, selected: true })),
    removed: diff.removed.map((row) => ({ ...row, selected: true })),
    modified: diff.modified.map((row) => ({ ...row, selected: true })),
  };
}

export function buildDataCompareSyncPlanTables(results: DataCompareTableResult[], targetSchema: string): DataCompareSyncPlanTableOptions[] {
  return results
    .filter((table) => table.status === "different")
    .map((table) => ({
      tableName: table.targetTable,
      schema: targetSchema,
      columns: table.columns,
      keyColumns: table.keyColumns,
      columnInfo: table.columnInfo,
      diff: {
        added: table.diff.added.filter((row) => row.selected).map(({ selected: _selected, ...row }) => row),
        removed: table.diff.removed.filter((row) => row.selected).map(({ selected: _selected, ...row }) => row),
        modified: table.diff.modified.filter((row) => row.selected).map(({ selected: _selected, ...row }) => row),
      },
      databaseType: table.databaseType,
      preSyncStatements: table.preSyncStatements ?? [],
    }))
    .filter((table) => table.preSyncStatements.length > 0 || table.diff.added.length > 0 || table.diff.removed.length > 0 || table.diff.modified.length > 0);
}

function publishProgress(session: DataCompareSession, progress: DataCompareSessionProgress): void {
  session.version += 1;
  session.progress = progress;
  const results = session.batchResults;
  const failedTableCount = results.filter((item) => item.status === "error").length;
  const tracker = useExportTracker();
  tracker.updateCompareTask(session.id, {
    status: "Running",
    compareCurrent: progress.current,
    compareTotal: progress.total,
    compareCurrentObject: progress.table,
    compareResultCount: results.length,
    compareSameCount: results.filter((item) => item.status === "same").length,
    compareDifferentCount: results.filter((item) => item.status === "different").length,
    compareFailedCount: failedTableCount,
    compareAddedCount: results.reduce((sum, item) => sum + item.added, 0),
    compareRemovedCount: results.reduce((sum, item) => sum + item.removed, 0),
    compareModifiedCount: results.reduce((sum, item) => sum + item.modified, 0),
  });
}

function updateResults(session: DataCompareSession, results: DataCompareTableResult[]): void {
  session.batchResults = [...results];
}

async function loadColumnsWithCache(cache: Map<string, CompareColumn[]>, connectionId: string, database: string, schema: string, table: string): Promise<CompareColumn[]> {
  const key = `${connectionId}:${database}:${schema}:${table}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const columns = (await api.getColumns(connectionId, database, schema, table)) as CompareColumn[];
  cache.set(key, columns);
  return columns;
}

async function inferKeyColumnsForTable(input: DataCompareSessionConfig, table: string, sourceColumnCache: Map<string, CompareColumn[]>): Promise<string[]> {
  if (!input.sourceConnectionId || !input.sourceDatabase || !input.sourceSchema || !table) return [];
  const columns = await loadColumnsWithCache(sourceColumnCache, input.sourceConnectionId, input.sourceDatabase, input.sourceSchema, table);
  return inferCompareKeyColumns(columns);
}

function buildTableResult(task: DataCompareTableTask, preparation: DataCompareFromTablesPreparation, keyColumns: string[], columns: string[], columnInfo: CompareColumn[], databaseType: DatabaseType | undefined): DataCompareTableResult {
  const added = preparation.result.added.length;
  const removed = preparation.result.removed.length;
  const modified = preparation.result.modified.length;
  const status: DataCompareTableStatus = added || removed || modified ? "different" : "same";
  return {
    sourceTable: task.sourceTable,
    targetTable: task.targetTable,
    keyColumns,
    columns,
    columnInfo,
    status,
    added,
    removed,
    modified,
    sourceRowCount: preparation.sourceRowCount,
    targetRowCount: preparation.targetRowCount,
    sourceTruncated: preparation.sourceTruncated,
    targetTruncated: preparation.targetTruncated,
    databaseType,
    preSyncStatements: preparation.preSyncStatements,
    diff: toSelectableDiff(preparation.result),
    expanded: status === "different",
    showAll: { added: false, removed: false, modified: false },
  };
}

function buildMissingTargetResult(task: DataCompareTableTask, preparation: DataCompareFromTablesPreparation, sourceColumns: CompareColumn[], keyColumns: string[], databaseType: DatabaseType | undefined): DataCompareTableResult {
  return {
    sourceTable: task.sourceTable,
    targetTable: task.targetTable,
    keyColumns,
    columns: sourceColumns.map((column) => column.name),
    columnInfo: sourceColumns,
    status: "different",
    added: preparation.result.added.length,
    removed: 0,
    modified: 0,
    sourceRowCount: preparation.sourceRowCount,
    targetRowCount: 0,
    sourceTruncated: preparation.sourceTruncated,
    targetTruncated: false,
    databaseType,
    preSyncStatements: preparation.preSyncStatements,
    diff: toSelectableDiff(preparation.result),
    expanded: preparation.result.added.length > 0,
    showAll: { added: false, removed: false, modified: false },
  };
}

function buildErrorResult(task: DataCompareTableTask, keyColumns: string[], databaseType: DatabaseType | undefined, error: unknown): DataCompareTableResult {
  return {
    sourceTable: task.sourceTable,
    targetTable: task.targetTable,
    keyColumns,
    columns: [],
    columnInfo: [],
    status: "error",
    added: 0,
    removed: 0,
    modified: 0,
    sourceRowCount: 0,
    targetRowCount: 0,
    sourceTruncated: false,
    targetTruncated: false,
    databaseType,
    preSyncStatements: [],
    diff: { added: [], removed: [], modified: [] },
    expanded: false,
    showAll: { added: false, removed: false, modified: false },
    error: sessionError(error),
  };
}

async function runDataCompareSession(session: DataCompareSession, tasks: DataCompareTableTask[], dependencies: DataCompareSessionDependencies): Promise<void> {
  const input = session.config;
  const sourceColumnCache = new Map<string, CompareColumn[]>();
  const targetColumnCache = new Map<string, CompareColumn[]>();
  const results: DataCompareTableResult[] = [];
  const databaseType = dependencies.getConfig(input.targetConnectionId)?.db_type;

  try {
    publishProgress(session, { current: 0, total: tasks.length, table: "" });
    await Promise.all([dependencies.ensureConnected(input.sourceConnectionId), dependencies.ensureConnected(input.targetConnectionId)]);

    for (const [index, task] of tasks.entries()) {
      publishProgress(session, { current: index + 1, total: tasks.length, table: task.sourceTable });
      let keyColumns = input.keyColumns;
      try {
        if (input.targetTables.includes(task.targetTable)) {
          const resolvedKeys = input.keyColumns.length > 0 ? input.keyColumns : await inferKeyColumnsForTable(input, task.sourceTable, sourceColumnCache);
          if (resolvedKeys.length === 0) throw new Error(compareErrorMessage(dependencies, "noKeyColumns"));

          const sourceColumns = await loadColumnsWithCache(sourceColumnCache, input.sourceConnectionId, input.sourceDatabase, input.sourceSchema, task.sourceTable);
          const targetColumns = await loadColumnsWithCache(targetColumnCache, input.targetConnectionId, input.targetDatabase, input.targetSchema, task.targetTable);
          const matched = intersectCompareColumns(sourceColumns, targetColumns);
          const columns = matched.columns;
          const columnInfo = columns.map((column) => targetColumns.find((target) => target.name === column)).filter((column): column is CompareColumn => !!column);
          const canonicalKeyColumns: string[] = [];
          const missingKeys: string[] = [];
          for (const key of resolvedKeys) {
            const canonical = matchColumnNameIgnoreCase(key, columns);
            if (!canonical) missingKeys.push(key);
            else if (!canonicalKeyColumns.includes(canonical)) canonicalKeyColumns.push(canonical);
          }
          if (missingKeys.length > 0) throw new Error(compareErrorMessage(dependencies, "missingKeyColumns", missingKeys.join(", ")));
          if (columns.length === 0) throw new Error(compareErrorMessage(dependencies, "noCommonColumns"));

          const preparation = await api.prepareDataCompareFromTables({
            sourceConnectionId: input.sourceConnectionId,
            sourceDatabase: input.sourceDatabase,
            sourceSchema: input.sourceSchema,
            sourceTable: task.sourceTable,
            targetConnectionId: input.targetConnectionId,
            targetDatabase: input.targetDatabase,
            targetSchema: input.targetSchema,
            targetTable: task.targetTable,
            columns,
            keyColumns: canonicalKeyColumns,
            sourceColumns: matched.sourceColumns,
          });
          keyColumns = canonicalKeyColumns;
          results.push(buildTableResult(task, preparation, canonicalKeyColumns, columns, columnInfo, databaseType));
        } else {
          const sourceColumns = await loadColumnsWithCache(sourceColumnCache, input.sourceConnectionId, input.sourceDatabase, input.sourceSchema, task.sourceTable);
          const resolvedKeys = input.keyColumns.length > 0 ? input.keyColumns : [];
          const sourceColumnNames = sourceColumns.map((column) => column.name);
          keyColumns = resolvedKeys.map((key) => matchColumnNameIgnoreCase(key, sourceColumnNames) ?? key);
          const preparation = await api.prepareDataCompareMissingTarget({
            sourceConnectionId: input.sourceConnectionId,
            sourceDatabase: input.sourceDatabase,
            sourceSchema: input.sourceSchema,
            sourceTable: task.sourceTable,
            targetConnectionId: input.targetConnectionId,
            targetDatabase: input.targetDatabase,
            targetSchema: input.targetSchema,
            targetTable: task.targetTable,
            keyColumns,
          });
          results.push(buildMissingTargetResult(task, preparation, sourceColumns, keyColumns, databaseType));
        }
      } catch (error: unknown) {
        results.push(buildErrorResult(task, keyColumns, databaseType, error));
      }
      updateResults(session, results);
      publishProgress(session, { current: index + 1, total: tasks.length, table: task.sourceTable });
    }

    const plan = await api.buildDataCompareSyncPlan({ tables: buildDataCompareSyncPlanTables(results, input.targetSchema) });
    session.syncPlan = plan;
    session.progress = null;
    session.status = "completed";
    session.version += 1;
    session.finishedAt = Date.now();
    const sameCount = results.filter((item) => item.status === "same").length;
    const differentCount = results.filter((item) => item.status === "different").length;
    const failedCount = results.filter((item) => item.status === "error").length;
    useExportTracker().updateCompareTask(session.id, {
      status: failedCount > 0 ? "Error" : "Done",
      compareCurrent: tasks.length,
      compareTotal: tasks.length,
      compareCurrentObject: "",
      compareResultCount: results.length,
      compareSameCount: sameCount,
      compareDifferentCount: differentCount,
      compareFailedCount: failedCount,
      compareAddedCount: results.reduce((sum, item) => sum + item.added, 0),
      compareRemovedCount: results.reduce((sum, item) => sum + item.removed, 0),
      compareModifiedCount: results.reduce((sum, item) => sum + item.modified, 0),
      errorMessage: failedCount > 0 ? `${failedCount} table(s) failed` : null,
    });
  } catch (error: unknown) {
    const message = sessionError(error);
    const lastProgress = session.progress;
    session.error = message;
    session.progress = null;
    session.status = "failed";
    session.version += 1;
    session.finishedAt = Date.now();
    useExportTracker().updateCompareTask(session.id, {
      status: "Error",
      errorMessage: message,
      compareCurrent: lastProgress?.current,
      compareTotal: lastProgress?.total,
      compareCurrentObject: lastProgress?.table,
    });
  }
}

export function startDataCompareSession(input: DataCompareSessionConfig, tasks: DataCompareTableTask[], dependencies: DataCompareSessionDependencies): DataCompareSession {
  const id = uuid();
  const session = shallowReactive<DataCompareSession>({
    id,
    version: 0,
    status: "running",
    config: cloneConfig(input),
    progress: null,
    batchResults: [],
    syncPlan: emptyDataCompareSyncPlan(),
    error: null,
    startedAt: Date.now(),
  });
  sessions.set(id, session);

  const tracker = useExportTracker();
  tracker.addDataCompareTask(
    id,
    input.label,
    () => openDataCompareSession(id),
    () => removeDataCompareSession(id),
  );
  void runDataCompareSession(session, tasks, dependencies);
  return session;
}

export function getDataCompareSession(id: string | null | undefined): DataCompareSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export function removeDataCompareSession(id: string): boolean {
  const session = sessions.get(id);
  if (session?.status === "running") return false;
  return sessions.delete(id);
}
