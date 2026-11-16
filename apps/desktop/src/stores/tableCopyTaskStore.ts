import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import * as api from "@/lib/backend/api";
import { BackendErrorException, normalizeBackendError } from "@/lib/backend/errorUtils";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { tableDataCopyColumnOptions, type PasteTableMode } from "@/lib/table/tableClipboard";
import { uuid } from "@/lib/common/utils";
import { useConnectionStore } from "./connectionStore";
import { useQueryStore } from "./queryStore";
import { useProductionSafetyStore } from "./productionSafetyStore";
import type { ConnectionConfig } from "@/types/database";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useToast } from "@/composables/useToast";
import i18n from "@/i18n";

export interface MysqlTableCopyEntry {
  connection: ConnectionConfig;
  database: string;
  catalog?: string;
  schema?: string;
  sourceName: string;
  targetName: string;
  tableComment?: string | null;
  identifierQuote?: string;
}

type CopyStatus = "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface TableCopyTask {
  id: string;
  status: CopyStatus;
  phase: "preparing" | "structure" | "data" | "refreshing";
  startedAt: number;
  finishedAt?: number;
  currentIndex: number;
  targets: Array<{ name: string; status: "pending" | CopyStatus; structureCreated: boolean; copiedRows?: number; error?: string }>;
  error?: string;
  refreshError?: string;
  cancelError?: string;
}

class CopyCancelled extends Error {}
class CopyOutcomeUnknown extends Error {}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function observeExecution(id: string, cancel: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      api.cancelConditionalUpdate(id, cancel ? undefined : { cancel: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Execution status request timed out. The original copy result is still pending.")), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One app-owned task shared by both clone/paste entry points, independent of their lifetime. */
export const useTableCopyTaskStore = defineStore("tableCopyTask", () => {
  const task = ref<TableCopyTask>();
  const viewedTask = ref<TableCopyTask>();
  const displayedTask = computed(() => viewedTask.value ?? task.value);
  const open = ref(false);
  const executionId = ref<string>();
  const cancelSending = ref(false);
  const busy = computed(() => !!executionId.value || task.value?.status === "running" || task.value?.status === "cancelling" || (task.value?.phase === "refreshing" && !task.value.finishedAt));
  let cancelRequested = false;
  const tracker = useExportTracker();
  let trackedTask: ExportTask | undefined;

  function showDetails(record = task.value) {
    if (!record) return;
    viewedTask.value = record;
    open.value = true;
  }

  function syncBackgroundTask() {
    const current = task.value;
    if (!current || trackedTask?.exportId !== current.id) return;
    const status = current.status;
    Object.assign(trackedTask, {
      status: status === "unknown" ? (busy.value ? "Unknown" : "Error") : busy.value ? (status === "cancelling" ? "Cancelling" : "Running") : status === "succeeded" ? "Done" : status === "cancelled" ? "Cancelled" : "Error",
      copyPhase: busy.value && status !== "unknown" ? (status === "cancelling" ? "cancelling" : current.phase) : status,
      currentTable: current.targets[current.currentIndex]?.name,
      affectedRows: current.targets.some((target) => target.copiedRows !== undefined) ? current.targets.reduce((sum, target) => sum + (target.copiedRows ?? 0), 0) : undefined,
      errorMessage: [current.error, current.refreshError, current.cancelError].filter(Boolean).join("\n") || null,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      canCancel: busy.value && current.phase !== "refreshing" && !cancelSending.value,
      canRemove: !busy.value,
    });
    if (busy.value) tracker.registerTaskCancelHandler(current.id, cancel);
    else tracker.unregisterTaskCancelHandler(current.id);
  }
  watch([task, busy, cancelSending], syncBackgroundTask, { deep: true, flush: "sync" });

  function notify(record: TableCopyTask, started: boolean) {
    const t = i18n.global.t;
    useToast().toast(started ? t("tableCopyTask.backgroundStarted") : t("tableCopyTask.backgroundFinished", { status: t(`tableCopyTask.${record.status}`) }), 5000, { label: t("tableCopyTask.details"), onClick: () => showDetails(record) });
  }

  function checkCancelled() {
    if (cancelRequested) throw new CopyCancelled();
  }

  async function cancel() {
    if (!task.value || !busy.value || cancelSending.value) return;
    if (task.value.phase === "refreshing") return; // The database outcome is already final.
    cancelRequested = true;
    if (task.value.status !== "unknown") task.value.status = "cancelling";
    useProductionSafetyStore().cancelScope(task.value.id);
    const id = executionId.value;
    if (!id) return; // Planning and safety confirmation check again before dispatch.
    cancelSending.value = true;
    task.value.cancelError = undefined;
    try {
      // Registration can race a just-dispatched IPC/HTTP request. Never interpret
      // a missing registration, or a cancellation request, as a completed copy.
      for (let attempt = 0; attempt < 5 && executionId.value === id; attempt++) {
        const result = await observeExecution(id, true);
        if (result.requested || result.terminal) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      if (executionId.value === id) task.value.cancelError = message(error);
    } finally {
      cancelSending.value = false;
    }
  }

  async function checkCompletion() {
    const id = executionId.value;
    if (!id || !task.value || cancelSending.value) return;
    cancelSending.value = true;
    try {
      const result = await observeExecution(id, false);
      // A lost response never becomes a success or permission to replay. Only
      // release the running-task guard when the original DB execution ended.
      if (executionId.value === id && task.value.status === "unknown" && result.databaseTerminal === true) {
        executionId.value = undefined;
        task.value.finishedAt = Date.now();
      }
    } catch (error) {
      task.value.cancelError = message(error);
    } finally {
      cancelSending.value = false;
    }
  }

  function close() {
    open.value = false; // Only hides details; the app-owned task keeps running.
  }

  async function run(input: readonly MysqlTableCopyEntry[], mode: PasteTableMode): Promise<boolean> {
    if (busy.value) {
      showDetails();
      return false;
    }
    if (!input.length) return false;
    // Capture all identities before the first await. Do not retain credentials in UI state.
    const entries = input.map((entry) => ({ ...entry, connection: { ...entry.connection }, targetName: entry.targetName.trim() }));
    cancelRequested = false;
    task.value = { id: uuid(), status: "running", phase: "preparing", startedAt: Date.now(), currentIndex: 0, targets: entries.map((entry) => ({ name: entry.targetName, status: "pending", structureCreated: false })) };
    const current = task.value;
    viewedTask.value = current;
    open.value = false;
    trackedTask = tracker.addTableCopyTask(current.id, current.targets.map((target) => target.name).join(", "), () => showDetails(current));
    syncBackgroundTask();
    notify(current, true);
    const refresh = new Set<MysqlTableCopyEntry>();

    async function execute(entry: MysqlTableCopyEntry, sql: string) {
      checkCancelled();
      const result = await executeWithProductionSqlGuard({
        connection: entry.connection,
        database: entry.database,
        sql,
        source: "Table copy",
        scopeId: current.id,
        execute: async () => {
          checkCancelled();
          const id = uuid();
          executionId.value = id;
          try {
            // This existing command keeps the database execution owned until its
            // response/rollback settles instead of racing the cancellation token.
            const value = await api.executeConditionalUpdate(entry.connection.id, entry.database, sql, entry.schema, id, { timeoutSecs: 0, catalog: entry.catalog });
            if (value.execution_error) throw value.error ? new BackendErrorException(value.error) : new Error("The database did not confirm the table copy.");
            refresh.add(entry);
            executionId.value = undefined;
            return value;
          } catch (error) {
            const envelope = normalizeBackendError(error);
            const rejected = envelope?.operationOutcome === "not_started" || (envelope?.diagnostics?.category === "sql" && envelope.diagnostics.stage === "execute");
            if (!rejected) throw new CopyOutcomeUnknown(message(error));
            // A failed data write may have partially changed a nontransactional
            // target. A rejected CREATE, however, must not reload an existing,
            // untouched target (which may have unsaved edits).
            if (current.phase === "data") refresh.add(entry);
            executionId.value = undefined;
            if (cancelRequested && /cancel(?:led|ed)?|query execution was interrupted/i.test(envelope?.detail || message(error))) throw new CopyCancelled();
            throw error;
          }
        },
      });
      if (result === undefined) throw new CopyCancelled(); // Read-only/production guard denied dispatch.
      return result;
    }

    for (const [index, entry] of entries.entries()) {
      const target = current.targets[index]!;
      current.currentIndex = index;
      current.phase = "preparing";
      try {
        checkCancelled();
        target.status = "running";
        await useConnectionStore().ensureConnected(entry.connection.id);
        checkCancelled();
        const { buildCopyTableDataSql, buildDuplicateTableStructurePlan } = await import("@/lib/database/dbAdminSql");
        checkCancelled();
        if (mode !== "data-only") {
          const plan = await buildDuplicateTableStructurePlan({ ...entry, connectionId: entry.connection.id, databaseType: "mysql" });
          checkCancelled();
          current.phase = "structure";
          await execute(entry, plan.sql);
          target.structureCreated = true;
        }
        if (mode !== "structure-only") {
          checkCancelled();
          current.phase = "preparing";
          const columns = await api.getColumns(entry.connection.id, entry.database, entry.schema || "", entry.sourceName, entry.catalog);
          checkCancelled();
          const options = tableDataCopyColumnOptions("mysql", columns);
          if (!options.columns.length) throw new Error("No writable columns available for table data copy.");
          const sql = await buildCopyTableDataSql({ ...entry, ...options, databaseType: "mysql", normalizeNewTargetName: mode === "structure-and-data" });
          checkCancelled();
          current.phase = "data";
          const result = await execute(entry, sql);
          target.copiedRows = result.affected_rows;
        }
        target.status = "succeeded"; // A late cancel cannot undo an acknowledged successful statement.
      } catch (error) {
        if (error instanceof CopyCancelled) {
          target.status = "cancelled";
          current.status = "cancelled";
          break;
        }
        target.error = message(error);
        current.error ??= target.error;
        if (error instanceof CopyOutcomeUnknown) {
          target.status = "unknown";
          current.status = "unknown";
          break;
        }
        target.status = "failed";
      }
    }
    if (current.status === "running" || current.status === "cancelling") current.status = current.targets.some((target) => target.status === "failed") ? "failed" : "succeeded";
    if (current.status !== "unknown") {
      current.phase = "refreshing";
      // Mutation outcome and refresh errors are independent: never suggest
      // replaying a successful copy because refreshing an open tab failed.
      for (const entry of refresh) {
        const results = await Promise.allSettled([
          useConnectionStore().refreshObjectListTreeNode(entry.connection.id, entry.database, entry.schema),
          useQueryStore().refreshDataTabsForTable({ connectionId: entry.connection.id, database: entry.database, schema: entry.schema, catalog: entry.catalog, name: entry.targetName }),
        ]);
        for (const result of results) if (result.status === "rejected") current.refreshError ??= message(result.reason);
      }
      current.finishedAt = Date.now();
    }
    if (!open.value || displayedTask.value !== current) notify(current, false);
    return current.status === "succeeded";
  }

  return { task, displayedTask, open, busy, cancelSending, run, cancel, checkCompletion, close, showDetails };
});
