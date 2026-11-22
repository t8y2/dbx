import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";
import type { BackgroundTaskKind, BackgroundTaskLogLine, BackgroundTaskStatus, ExportTask } from "@/composables/useExportTracker";

/**
 * Background task snapshot (#14696).
 *
 * The task list lives in memory only, so a browser crash (or a desktop restart)
 * silently dropped every running export: when the app came back the tasks were
 * gone and the user had no way to tell whether the export was still running or
 * where the pre-crash log went. The snapshot keeps the last known state of each
 * task, including its execution log, in the same app-state store the tab
 * session uses. Tasks that were still running are restored as `Unknown`, which
 * the UI already renders as "export status unknown" — the export itself may or
 * may not have finished, and the user decides what to do with the output file.
 */

const APP_STATE_KEY = "background_tasks";
const MAX_PERSISTED_TASKS = 25;
const MAX_PERSISTED_LOG_LINES = 200;
const FINISHED_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES: readonly BackgroundTaskStatus[] = ["Done", "Error", "Cancelled"];

/** Fields the task UI renders. Anything else (callbacks, request payloads, failure maps) stays in memory. */
const PERSISTED_FIELDS = [
  "exportId",
  "kind",
  "tableName",
  "format",
  "filePath",
  "rowsExported",
  "totalRows",
  "status",
  "errorMessage",
  "logLines",
  "startedAt",
  "finishedAt",
  "databaseExportSource",
  "dataTransferLabel",
  "currentObject",
  "objectIndex",
  "totalObjects",
  "overallPercent",
  "statementSummary",
  "statementIndex",
  "currentTable",
  "totalTables",
  "tableIndex",
  "successCount",
  "failureCount",
  "affectedRows",
  "elapsedMs",
  "bytesRead",
  "totalBytes",
  "sqlFilePhase",
  "copyPhase",
  "comparePhase",
  "compareCurrent",
  "compareTotal",
  "compareCurrentObject",
  "compareResultCount",
  "compareSameCount",
  "compareDifferentCount",
  "compareFailedCount",
  "compareAddedCount",
  "compareRemovedCount",
  "compareModifiedCount",
  "dictionaryPhase",
  "dictionaryCompleted",
  "dictionaryTotal",
  "dictionaryCurrent",
  "dictionaryWarnings",
  "dictionaryProgressKnown",
  "multiDbTotal",
  "multiDbCompleted",
  "multiDbSuccessCount",
  "multiDbFailureCount",
  "multiDbSkippedCount",
  "multiDbNotExecutedCount",
  "canRemove",
] as const;

export type PersistedExportTask = Record<string, unknown> & { exportId: string; status: BackgroundTaskStatus };

const KNOWN_KINDS: readonly BackgroundTaskKind[] = ["table-export", "table-copy", "database-export", "data-dictionary", "sql-file", "data-transfer", "data-generation", "multi-db-execution", "schema-diff", "data-compare"];

const KNOWN_STATUSES: readonly BackgroundTaskStatus[] = ["Queued", "Unknown", "PreparingSnapshot", "Running", "Writing", "Cancelling", "Done", "Error", "Cancelled"];

function isTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Snapshot the tasks worth restoring: everything still in flight plus the most
 * recent finished ones, in list order. Removed tasks and tasks the caller marked
 * as not removable are skipped — they are deliberately invisible.
 */
export function serializeExportTasks(tasks: readonly ExportTask[]): PersistedExportTask[] {
  const persisted: PersistedExportTask[] = [];
  const now = Date.now();
  for (const task of tasks) {
    if (task.removed || task.canRemove === false) continue;
    // Finished tasks are only kept long enough to explain what happened after a
    // crash; older ones must not resurrect on every start.
    if ((isTerminal(task.status) || task.restored) && typeof task.finishedAt === "number" && now - task.finishedAt > FINISHED_TASK_RETENTION_MS) continue;
    const snapshot: Record<string, unknown> = {};
    for (const field of PERSISTED_FIELDS) {
      const value = (task as unknown as Record<string, unknown>)[field];
      if (value !== undefined) snapshot[field] = value;
    }
    if (Array.isArray(task.logLines) && task.logLines.length > MAX_PERSISTED_LOG_LINES) {
      snapshot.logLines = task.logLines.slice(-MAX_PERSISTED_LOG_LINES);
    }
    persisted.push(snapshot as PersistedExportTask);
  }
  return persisted.slice(-MAX_PERSISTED_TASKS);
}

function isLogLine(value: unknown): value is BackgroundTaskLogLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<BackgroundTaskLogLine>;
  return typeof line.at === "number" && typeof line.key === "string" && typeof line.level === "string";
}

/**
 * Turn a stored snapshot back into tasks. Anything that was not terminal is
 * downgraded to `Unknown`: the run had no live handle after the reload, so the
 * app cannot claim it is still running, and it must not offer a cancel that
 * would silently fail.
 */
export function deserializeExportTasks(raw: unknown): ExportTask[] {
  if (!Array.isArray(raw)) return [];
  const restored: ExportTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = record.kind as BackgroundTaskKind | undefined;
    const status = record.status as BackgroundTaskStatus | undefined;
    if (typeof record.exportId !== "string" || !record.exportId) continue;
    if (!kind || !KNOWN_KINDS.includes(kind)) continue;
    if (!status || !KNOWN_STATUSES.includes(status)) continue;

    const task = { ...record } as unknown as ExportTask;
    task.kind = kind;
    task.status = isTerminal(status) ? status : "Unknown";
    task.tableName = typeof record.tableName === "string" ? record.tableName : "";
    task.format = typeof record.format === "string" ? record.format : "";
    task.filePath = typeof record.filePath === "string" ? record.filePath : "";
    task.rowsExported = typeof record.rowsExported === "number" ? record.rowsExported : 0;
    task.totalRows = typeof record.totalRows === "number" ? record.totalRows : null;
    task.errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : null;
    task.logLines = Array.isArray(record.logLines) ? record.logLines.filter(isLogLine) : undefined;
    // No live handle survives the reload: cancel would fail, removal is fine.
    task.canCancel = false;
    task.canRecoverCancellation = false;
    task.canRemove = true;
    task.restored = true;
    // Stamp the moment the interruption was detected so the restored entry ages
    // out like a finished one instead of being re-persisted forever.
    if (task.status === "Unknown" && typeof task.finishedAt !== "number") task.finishedAt = Date.now();
    delete task.onOpen;
    delete task.onRemove;
    restored.push(task);
  }
  return restored;
}

export async function loadPersistedExportTasks(): Promise<ExportTask[]> {
  try {
    const stored = await loadBrowserAppState(APP_STATE_KEY);
    return deserializeExportTasks(stored);
  } catch (error) {
    console.warn("[DBX][export-tasks:restore:error]", error);
    return [];
  }
}

export async function savePersistedExportTasks(tasks: readonly ExportTask[]): Promise<void> {
  try {
    await saveBrowserAppState(APP_STATE_KEY, serializeExportTasks(tasks));
  } catch (error) {
    console.warn("[DBX][export-tasks:persist:error]", error);
  }
}
