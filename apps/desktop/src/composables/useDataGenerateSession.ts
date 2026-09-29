import { reactive, shallowReactive } from "vue";
import { openDataGenerateSession } from "@/composables/useDialogSources";
import { useExportTracker } from "@/composables/useExportTracker";
import * as api from "@/lib/backend/api";
import { createTableGenerateState, formatGeneratedRowValues, generateInsertBatches, generateTableRowsChunk, splitValueRowsByByteBudget, type ColumnGenerateConfig, type GenerateResult, type TableGenerateConfig } from "@/lib/dataGrid/dataGenerate";
import { errorMessage, isQueryCanceledError, summarizeBatchResults } from "@/lib/dataGrid/generateInsertAccounting";
import { qualifiedTableName } from "@/lib/table/tableSelectSql";
import { uuid } from "@/lib/common/utils";
import type { DatabaseType, QueryResult } from "@/types/database";

const DEFAULT_BATCH_ROWS = 1000;
const MAX_BATCH_BYTES = 1024 * 1024;

export interface DataGenerateTarget extends GenerateResult {
  tableName: string;
  schema: string;
  database: string;
  tableType?: string;
  targetRowCount: number;
  isSample: boolean;
  resolvedColumns: ColumnGenerateConfig[];
}

export interface DataGenerateRunOptions {
  continueOnError: boolean;
  truncate: boolean;
  useTransaction: boolean;
  extendedInsert: boolean;
  timeoutSecs: number;
  batchRows: number;
}

export interface DataGenerateTableResult {
  table: string;
  total: number;
  ok: number;
  err: number;
  error?: string;
  cancelled?: boolean;
}

export interface DataGenerateSessionProgress {
  tableName: string;
  tableIndex: number;
  tableCount: number;
  insertedRows: number;
  totalRows: number;
  elapsedMs: number;
}

export type DataGenerateSessionStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface DataGenerateSessionConfig {
  connectionId: string;
  database: string;
  prefillSchema?: string;
  databaseType?: DatabaseType;
  label: string;
  targets: DataGenerateTarget[];
  options: DataGenerateRunOptions;
}

export interface DataGenerateSession {
  id: string;
  version: number;
  status: DataGenerateSessionStatus;
  config: DataGenerateSessionConfig;
  progress: DataGenerateSessionProgress | null;
  results: DataGenerateTableResult[];
  error: string | null;
  startedAt: number;
  finishedAt?: number;
}

interface MutableDataGenerateSession extends DataGenerateSession {
  cancelRequested: boolean;
  activeExecutionId: string | null;
}

export interface DataGenerateSessionDependencies {
  invalidateMetadataCache(connectionId: string, database: string, schema?: string, table?: string): void;
  formatGenerationError?: (error: unknown) => string;
}

interface TableInsertOutcome {
  ok: number;
  attempted: number;
  error: string;
  cancelled: boolean;
}

const sessions = reactive(new Map<string, MutableDataGenerateSession>());

function normalizeTimeoutSecs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(86_400, Math.floor(value));
}

function cloneColumn(column: ColumnGenerateConfig): ColumnGenerateConfig {
  return {
    ...column,
    generatorParams: column.generatorParams
      ? {
          ...column.generatorParams,
          languages: column.generatorParams.languages ? [...column.generatorParams.languages] : undefined,
          weekdays: column.generatorParams.weekdays ? [...column.generatorParams.weekdays] : undefined,
          phoneRegions: column.generatorParams.phoneRegions ? [...column.generatorParams.phoneRegions] : undefined,
          cardTypes: column.generatorParams.cardTypes ? [...column.generatorParams.cardTypes] : undefined,
          regions: column.generatorParams.regions ? [...column.generatorParams.regions] : undefined,
          idTypes: column.generatorParams.idTypes ? [...column.generatorParams.idTypes] : undefined,
          barcodeTypes: column.generatorParams.barcodeTypes ? [...column.generatorParams.barcodeTypes] : undefined,
          pathTypes: column.generatorParams.pathTypes ? [...column.generatorParams.pathTypes] : undefined,
        }
      : undefined,
  };
}

function cloneTarget(target: DataGenerateTarget): DataGenerateTarget {
  return {
    ...target,
    columns: [...target.columns],
    rows: target.rows.map((row) => [...row]),
    statements: [...target.statements],
    resolvedColumns: target.resolvedColumns.map(cloneColumn),
  };
}

function cloneConfig(config: DataGenerateSessionConfig): DataGenerateSessionConfig {
  return {
    ...config,
    targets: config.targets.map(cloneTarget),
    options: { ...config.options },
  };
}

function generationError(dependencies: DataGenerateSessionDependencies, error: unknown): string {
  return dependencies.formatGenerationError?.(error) ?? errorMessage(error);
}

function totalTargetRows(session: DataGenerateSession): number {
  return session.config.targets.reduce((sum, target) => sum + target.targetRowCount, 0);
}

function insertedRows(session: DataGenerateSession, currentRows = 0): number {
  return session.results.reduce((sum, result) => sum + result.ok, 0) + currentRows;
}

function publishProgress(session: MutableDataGenerateSession, progress: DataGenerateSessionProgress, currentRows = progress.insertedRows): void {
  session.version += 1;
  session.progress = progress;
  useExportTracker().updateDataGenerationTask(session.id, {
    status: session.status === "cancelling" ? "Cancelling" : "Running",
    tableIndex: progress.tableIndex,
    totalTables: progress.tableCount,
    currentTable: progress.tableName,
    rowsGenerated: insertedRows(session, currentRows),
    totalRows: totalTargetRows(session),
  });
}

async function streamInsertTable(session: MutableDataGenerateSession, target: DataGenerateTarget, dependencies: DataGenerateSessionDependencies, onRows: (insertedRows: number) => void): Promise<TableInsertOutcome> {
  const { connectionId, database, databaseType, options, prefillSchema } = session.config;
  const config: TableGenerateConfig = {
    tableName: target.tableName,
    schema: target.schema,
    database: target.database || database,
    tableType: target.tableType,
    rowCount: target.targetRowCount,
    columns: target.resolvedColumns,
  };
  const state = createTableGenerateState(config, databaseType);
  const schema = target.schema || prefillSchema;
  const forceSingleRow = !options.extendedInsert;
  const timeoutSecs = normalizeTimeoutSecs(options.timeoutSecs);
  const batchRows = Math.max(1, Math.floor(options.batchRows) || DEFAULT_BATCH_ROWS);
  let ok = 0;
  let attempted = 0;
  let lastError = "";
  let cancelled = false;

  const run = (sql: string): Promise<QueryResult[]> =>
    api.executeMultiWithProgress(connectionId, database, sql, () => {}, schema, {
      timeoutSecs,
      useTransaction: options.useTransaction,
      continueOnError: options.continueOnError,
      executionId: session.id,
    });

  const executeBatch = async (statements: string[], rowsPerStatement: number[]): Promise<boolean> => {
    const expectedRows = rowsPerStatement.reduce((sum, rows) => sum + rows, 0);
    attempted += expectedRows;
    try {
      const results = await run(statements.join("\n"));
      if (expectedRows > 0 && (!results || results.length === 0)) {
        if (!lastError) lastError = "Backend returned no result for the batch";
        return options.continueOnError;
      }
      const outcome = summarizeBatchResults(results, rowsPerStatement);
      ok += outcome.insertedRows;
      if (!outcome.failed) return true;
      if (!lastError) lastError = outcome.error ?? "Statement failed";
      return options.continueOnError;
    } catch (error: unknown) {
      if (session.cancelRequested || isQueryCanceledError(error)) {
        cancelled = true;
        return false;
      }
      if (!lastError) lastError = errorMessage(error);
      return options.continueOnError;
    }
  };

  const finish = (): TableInsertOutcome => ({ ok, attempted, error: cancelled ? "" : lastError, cancelled });

  if (options.truncate) {
    const table = qualifiedTableName({ databaseType, schema: target.schema, tableName: target.tableName, database });
    if (!(await executeBatch([`TRUNCATE TABLE ${table};`], [0]))) return finish();
  }

  while (state.nextIndex < target.targetRowCount && !session.cancelRequested) {
    let valueRows: string[];
    try {
      const rows = generateTableRowsChunk(config, state, batchRows);
      if (rows.length === 0) break;
      valueRows = rows.map((row) => formatGeneratedRowValues(config, databaseType, state, row));
    } catch (error: unknown) {
      if (!lastError) lastError = generationError(dependencies, error);
      return finish();
    }

    for (const group of splitValueRowsByByteBudget(state, valueRows, MAX_BATCH_BYTES)) {
      if (session.cancelRequested) break;
      const { statements, rowsPerStatement } = generateInsertBatches(databaseType, state, group, forceSingleRow);
      if (statements.length === 0) continue;
      const keepGoing = await executeBatch(statements, rowsPerStatement);
      onRows(ok);
      if (!keepGoing) return finish();
    }
    onRows(ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (session.cancelRequested) cancelled = true;
  return finish();
}

function finishSession(session: MutableDataGenerateSession, status: "completed" | "failed" | "cancelled", error: string | null): void {
  session.status = status;
  session.error = error;
  session.progress = null;
  session.finishedAt ??= Date.now();
  session.version += 1;
  const lastResult = session.results[session.results.length - 1];
  useExportTracker().updateDataGenerationTask(session.id, {
    status: status === "cancelled" ? "Cancelled" : status === "failed" || session.results.some((result) => result.err > 0 || !!result.error) ? "Error" : "Done",
    tableIndex: session.results.length,
    totalTables: session.config.targets.length,
    currentTable: lastResult?.table ?? "",
    rowsGenerated: insertedRows(session),
    totalRows: totalTargetRows(session),
    errorMessage: error ?? session.results.find((result) => result.error)?.error ?? null,
  });
}

async function runDataGenerateSession(session: MutableDataGenerateSession, dependencies: DataGenerateSessionDependencies): Promise<void> {
  const { connectionId, database, prefillSchema, targets, options } = session.config;
  try {
    let stopAll = false;
    for (const [index, target] of targets.entries()) {
      if (stopAll || session.cancelRequested) break;
      const initialProgress: DataGenerateSessionProgress = {
        tableName: target.tableName,
        tableIndex: index + 1,
        tableCount: targets.length,
        insertedRows: 0,
        totalRows: target.targetRowCount,
        elapsedMs: Date.now() - session.startedAt,
      };
      publishProgress(session, initialProgress, 0);

      let insertedSoFar = 0;
      let outcome: TableInsertOutcome;
      try {
        outcome = await streamInsertTable(session, target, dependencies, (rows) => {
          insertedSoFar = rows;
          publishProgress(
            session,
            {
              ...initialProgress,
              insertedRows: rows,
              elapsedMs: Date.now() - session.startedAt,
            },
            rows,
          );
        });
      } catch (error: unknown) {
        const wasCancelled = session.cancelRequested || isQueryCanceledError(error);
        outcome = { ok: insertedSoFar, attempted: insertedSoFar, error: wasCancelled ? "" : errorMessage(error), cancelled: wasCancelled };
      }

      const failedRows = Math.max(0, Math.max(outcome.attempted, outcome.ok) - outcome.ok);
      session.results = [
        ...session.results,
        {
          table: target.tableName,
          total: target.targetRowCount,
          ok: outcome.ok,
          err: failedRows,
          error: outcome.error || undefined,
          cancelled: outcome.cancelled || undefined,
        },
      ];
      session.version += 1;
      if (outcome.ok > 0) dependencies.invalidateMetadataCache(connectionId, database, target.schema || prefillSchema || undefined, target.tableName);
      if ((outcome.error && !options.continueOnError) || outcome.cancelled) stopAll = true;
    }

    if (session.cancelRequested || session.results.some((result) => result.cancelled)) {
      finishSession(session, "cancelled", null);
    } else {
      finishSession(session, "completed", null);
    }
  } catch (error: unknown) {
    finishSession(session, "failed", generationError(dependencies, error));
  } finally {
    session.activeExecutionId = null;
  }
}

export function startDataGenerateSession(config: DataGenerateSessionConfig, dependencies: DataGenerateSessionDependencies): DataGenerateSession {
  const id = uuid();
  const session = shallowReactive<MutableDataGenerateSession>({
    id,
    version: 0,
    status: "running",
    config: cloneConfig(config),
    progress: null,
    results: [],
    error: null,
    startedAt: Date.now(),
    cancelRequested: false,
    activeExecutionId: id,
  });
  sessions.set(id, session);

  const firstTarget = session.config.targets[0];
  const tracker = useExportTracker();
  tracker.addDataGenerationTask(
    id,
    config.label,
    totalTargetRows(session),
    session.config.targets.length,
    () =>
      openDataGenerateSession(id, {
        connectionId: config.connectionId,
        database: config.database,
        schema: firstTarget?.schema ?? config.prefillSchema ?? "",
        tableName: firstTarget?.tableName ?? "",
      }),
    () => removeDataGenerateSession(id),
  );
  tracker.registerTaskCancelHandler(id, async () => {
    await cancelDataGenerateSession(id);
  });
  void runDataGenerateSession(session, dependencies);
  return session;
}

export function getDataGenerateSession(id: string | null | undefined): DataGenerateSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export async function cancelDataGenerateSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || (session.status !== "running" && session.status !== "cancelling")) return false;
  session.cancelRequested = true;
  session.status = "cancelling";
  session.version += 1;
  const progress = session.progress;
  useExportTracker().updateDataGenerationTask(session.id, {
    status: "Cancelling",
    tableIndex: progress?.tableIndex ?? session.results.length,
    totalTables: session.config.targets.length,
    currentTable: progress?.tableName ?? "",
    rowsGenerated: insertedRows(session, progress?.insertedRows ?? 0),
    totalRows: totalTargetRows(session),
  });
  if (session.activeExecutionId) await api.cancelQuery(session.activeExecutionId).catch(() => undefined);
  return true;
}

export function removeDataGenerateSession(id: string): boolean {
  const session = sessions.get(id);
  if (session && (session.status === "running" || session.status === "cancelling")) return false;
  return sessions.delete(id);
}
