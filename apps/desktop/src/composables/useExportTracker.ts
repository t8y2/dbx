import { reactive, computed } from "vue";
import * as api from "@/lib/backend/api";
import { isTerminalTransferProgress } from "@/lib/backend/transferProgress";

export type BackgroundTaskKind = "table-export" | "database-export" | "sql-file" | "data-transfer";
export type BackgroundTaskStatus = "Running" | "Writing" | "Done" | "Error" | "Cancelled";

export interface ExportTask {
  exportId: string;
  kind: BackgroundTaskKind;
  tableName: string;
  format: string;
  filePath: string;
  rowsExported: number;
  totalRows: number | null;
  status: BackgroundTaskStatus;
  errorMessage: string | null;
  objectIndex?: number;
  totalObjects?: number;
  statementIndex?: number;
  successCount?: number;
  failureCount?: number;
  affectedRows?: number;
  elapsedMs?: number;
  statementSummary?: string;
  tableIndex?: number;
  totalTables?: number;
  currentTable?: string;
  targetConnectionId?: string;
  targetDatabase?: string;
  targetSchema?: string;
  targetTables?: string[];
}

const taskMap = reactive<Map<string, ExportTask>>(new Map());
const activeTransferRuns = new Set<string>();

function normalizeExportStatus(status: string): BackgroundTaskStatus {
  if (status === "Writing" || status === "Done" || status === "Error" || status === "Cancelled") return status;
  return "Running";
}

function normalizeSqlFileStatus(status: api.SqlFileStatus): BackgroundTaskStatus {
  if (status === "done") return "Done";
  if (status === "error") return "Error";
  if (status === "cancelled") return "Cancelled";
  return "Running";
}

function normalizeTransferStatus(status: api.TransferProgress["status"], terminal: boolean): BackgroundTaskStatus {
  if (status === "done") return "Done";
  if (status === "error") return terminal ? "Error" : "Running";
  if (status === "cancelled") return "Cancelled";
  return "Running";
}

function targetTableName(table: string, nameCase: api.TransferTableNameCase): string {
  if (nameCase === "lower") return table.toLowerCase();
  if (nameCase === "upper") return table.toUpperCase();
  return table;
}

function findActiveOverlappingTransfer(request: api.TransferRequest): string[] {
  const requestedTables = new Set(request.tables.map((table) => targetTableName(table, request.targetTableNameCase)));
  for (const task of taskMap.values()) {
    if (task.exportId === request.transferId) continue;
    if (task.kind !== "data-transfer") continue;
    if (task.status !== "Running" && task.status !== "Writing") continue;
    if (task.targetConnectionId !== request.targetConnectionId) continue;
    if (task.targetDatabase !== request.targetDatabase) continue;
    if (task.targetSchema !== request.targetSchema) continue;

    const overlappingTables = (task.targetTables ?? []).filter((table) => requestedTables.has(table));
    if (overlappingTables.length > 0) return overlappingTables;
  }
  return [];
}

export function useExportTracker() {
  const tasks = computed(() => Array.from(taskMap.values()));

  const activeCount = computed(() => tasks.value.filter((t) => t.status === "Running" || t.status === "Writing").length);

  const hasActive = computed(() => activeCount.value > 0);

  function generateUUID() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    let buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    buffer[6] = (buffer[6] & 0x0f) | 0x40;
    return Array.from(buffer, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }

  function addTask(tableName: string, format: string, filePath: string): ExportTask {
    const exportId = generateUUID();
    const task = reactive<ExportTask>({
      exportId,
      kind: "table-export",
      tableName,
      format,
      filePath,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
    });
    taskMap.set(exportId, task);
    return task;
  }

  function addDatabaseExportTask(exportId: string, label: string, filePath: string): ExportTask {
    const task = reactive<ExportTask>({
      exportId,
      kind: "database-export",
      tableName: label,
      format: "sql",
      filePath,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
      objectIndex: 0,
      totalObjects: 0,
    });
    taskMap.set(exportId, task);
    return task;
  }

  function addSqlFileTask(executionId: string, fileName: string, filePath: string): ExportTask {
    const task = reactive<ExportTask>({
      exportId: executionId,
      kind: "sql-file",
      tableName: fileName,
      format: "sql",
      filePath,
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
      statementIndex: 0,
      successCount: 0,
      failureCount: 0,
      affectedRows: 0,
      elapsedMs: 0,
      statementSummary: "",
    });
    taskMap.set(executionId, task);
    return task;
  }

  function addDataTransferTask(transferId: string, label: string, totalTables: number): ExportTask {
    const task = reactive<ExportTask>({
      exportId: transferId,
      kind: "data-transfer",
      tableName: label,
      format: "transfer",
      filePath: "",
      rowsExported: 0,
      totalRows: null,
      status: "Running",
      errorMessage: null,
      tableIndex: 0,
      totalTables,
      currentTable: "",
    });
    taskMap.set(transferId, task);
    return task;
  }

  function startDataTransferTask(
    request: api.TransferRequest,
    label: string,
    options: {
      onDone?: () => void | Promise<void>;
      formatOverlapError?: (tables: string[]) => string;
    } = {},
  ): ExportTask {
    const existingTask = taskMap.get(request.transferId);
    const task = existingTask ?? addDataTransferTask(request.transferId, label, request.tables.length);
    task.targetConnectionId = request.targetConnectionId;
    task.targetDatabase = request.targetDatabase;
    task.targetSchema = request.targetSchema;
    task.targetTables = request.tables.map((table) => targetTableName(table, request.targetTableNameCase));
    if (activeTransferRuns.has(request.transferId)) return task;

    const overlappingTables = findActiveOverlappingTransfer(request);
    if (overlappingTables.length > 0) {
      task.status = "Error";
      const visibleTables = overlappingTables.slice(0, 5);
      task.errorMessage = options.formatOverlapError?.(visibleTables) ?? `Another data transfer is already running for target table(s): ${visibleTables.join(", ")}`;
      return task;
    }

    activeTransferRuns.add(request.transferId);
    let terminalStatus: api.TransferProgress["status"] | null = null;

    void (async () => {
      try {
        await api.startTransfer(request, (progress) => {
          terminalStatus = isTerminalTransferProgress(progress) ? progress.status : terminalStatus;
          updateDataTransferTask(progress.transferId, progress);
        });

        if (terminalStatus === "done" && task.status === "Done") {
          await options.onDone?.();
        }
      } catch (e: any) {
        updateDataTransferTask(request.transferId, {
          transferId: request.transferId,
          table: task.currentTable || "",
          tableIndex: task.tableIndex ?? 0,
          totalTables: task.totalTables ?? request.tables.length,
          rowsTransferred: task.rowsExported,
          totalRows: task.totalRows,
          status: "error",
          error: e?.message || String(e),
          terminal: true,
        });
      } finally {
        activeTransferRuns.delete(request.transferId);
      }
    })();

    return task;
  }

  function updateTableExportTask(exportId: string, progress: api.TableExportProgress) {
    const task = taskMap.get(exportId);
    if (!task) return;
    task.tableName = progress.tableName || task.tableName;
    task.rowsExported = progress.rowsExported;
    task.totalRows = progress.totalRows;
    task.status = normalizeExportStatus(progress.status);
    task.errorMessage = progress.errorMessage || null;
  }

  function updateDatabaseExportTask(exportId: string, progress: api.ExportProgress) {
    const task = taskMap.get(exportId);
    if (!task) return;
    task.tableName = progress.currentObject || task.tableName;
    task.rowsExported = progress.rowsExported;
    task.totalRows = progress.totalRows;
    task.status = normalizeExportStatus(progress.status);
    task.errorMessage = progress.error || null;
    task.objectIndex = progress.objectIndex;
    task.totalObjects = progress.totalObjects;
  }

  function updateSqlFileTask(executionId: string, progress: api.SqlFileProgress) {
    const task = taskMap.get(executionId);
    if (!task) return;
    task.status = normalizeSqlFileStatus(progress.status);
    task.errorMessage = progress.error || null;
    task.statementIndex = progress.statementIndex;
    task.successCount = progress.successCount;
    task.failureCount = progress.failureCount;
    task.affectedRows = progress.affectedRows;
    task.elapsedMs = progress.elapsedMs;
    task.statementSummary = progress.statementSummary;
    task.rowsExported = progress.successCount + progress.failureCount;
    task.totalRows = Math.max(progress.statementIndex, progress.successCount + progress.failureCount) || null;
  }

  function updateDataTransferTask(transferId: string, progress: api.TransferProgress) {
    const task = taskMap.get(transferId);
    if (!task) return;
    const nextStatus = normalizeTransferStatus(progress.status, progress.terminal);
    const hadError = task.status === "Error";
    task.status = hadError && nextStatus === "Done" ? "Error" : nextStatus;
    task.errorMessage = progress.error || task.errorMessage || null;
    task.tableIndex = progress.tableIndex;
    task.totalTables = progress.totalTables;
    task.currentTable = progress.table || task.currentTable;
    if (progress.table || progress.rowsTransferred > 0 || task.rowsExported === 0) {
      task.rowsExported = progress.rowsTransferred;
    }
    task.totalRows = progress.totalRows ?? task.totalRows;
  }

  function removeTask(exportId: string) {
    taskMap.delete(exportId);
  }

  function clearFinished() {
    for (const [id, task] of taskMap) {
      if (task.status === "Done" || task.status === "Error" || task.status === "Cancelled") {
        taskMap.delete(id);
      }
    }
  }

  async function cancelTask(exportId: string) {
    const task = taskMap.get(exportId);
    try {
      if (task?.kind === "database-export") {
        await api.cancelDatabaseExport(exportId);
      } else if (task?.kind === "sql-file") {
        await api.cancelSqlFileExecution(exportId);
      } else if (task?.kind === "data-transfer") {
        await api.cancelTransfer(exportId);
      } else {
        await api.cancelTableExport(exportId);
      }
    } catch {
      // ignore
    }
  }

  return {
    tasks,
    activeCount,
    hasActive,
    addTask,
    addDatabaseExportTask,
    addSqlFileTask,
    addDataTransferTask,
    startDataTransferTask,
    updateTableExportTask,
    updateDatabaseExportTask,
    updateSqlFileTask,
    updateDataTransferTask,
    removeTask,
    clearFinished,
    cancelTask,
  };
}
