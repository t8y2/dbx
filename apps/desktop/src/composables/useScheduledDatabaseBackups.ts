import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import * as api from "@/lib/backend/api";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useConnectionStore } from "@/stores/connectionStore";
import { buildAllDatabaseExportPlan, generateDatabaseExportId, runDatabaseExportUntilTerminal } from "@/lib/export/databaseExport";
import {
  DATABASE_BACKUP_CONFIG_CHANGED_EVENT,
  DATABASE_BACKUP_RUNS_STORAGE_KEY,
  DATABASE_BACKUP_SCHEDULES_STORAGE_KEY,
  databaseBackupFilePath,
  databaseBackupRunsToPrune,
  databaseBackupScheduleIsDue,
  nextDatabaseBackupRunAt,
  normalizeDatabaseBackupSchedule,
  readDatabaseBackupRuns,
  readDatabaseBackupSchedules,
  resolveScheduledDatabaseBackupTargets,
  supportsScheduledDatabaseBackup,
  writeDatabaseBackupRuns,
  writeDatabaseBackupSchedules,
  type DatabaseBackupFile,
  type DatabaseBackupRun,
  type DatabaseBackupRunStatus,
  type DatabaseBackupRunTrigger,
  type DatabaseBackupSchedule,
} from "@/lib/backup/scheduledDatabaseBackup";
import { useExportTracker } from "@/composables/useExportTracker";

const SCHEDULER_INTERVAL_MS = 30_000;

const schedules = ref<DatabaseBackupSchedule[]>(readDatabaseBackupSchedules());
const runs = ref<DatabaseBackupRun[]>(readDatabaseBackupRuns());
const activeScheduleIds = reactive(new Set<string>());
const activeRunIds = reactive(new Set<string>());
const activeExportIds = new Map<string, string>();
const cancellationRequested = new Set<string>();

let schedulerTimer: ReturnType<typeof window.setInterval> | undefined;
let schedulerRegistered = false;
let processingDueSchedules = false;

function emitConfigChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DATABASE_BACKUP_CONFIG_CHANGED_EVENT));
}

function persistSchedules() {
  writeDatabaseBackupSchedules(schedules.value);
  emitConfigChanged();
}

function persistRuns() {
  writeDatabaseBackupRuns(runs.value);
}

function replaceRun(run: DatabaseBackupRun) {
  runs.value = [run, ...runs.value.filter((existing) => existing.id !== run.id)];
  persistRuns();
}

function updateRun(runId: string, patch: Partial<DatabaseBackupRun>): DatabaseBackupRun | null {
  const existing = runs.value.find((run) => run.id === runId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  replaceRun(updated);
  return updated;
}

function refreshFromStorage() {
  schedules.value = readDatabaseBackupSchedules();
  runs.value = readDatabaseBackupRuns();
}

export function useScheduledDatabaseBackups(options: { scheduler?: boolean } = {}) {
  const connectionStore = useConnectionStore();
  const { addDatabaseExportTask, registerTaskCancelHandler, unregisterTaskCancelHandler, updateDatabaseExportTask } = useExportTracker();

  const activeRuns = computed(() => runs.value.filter((run) => activeRunIds.has(run.id)));

  function saveSchedule(value: DatabaseBackupSchedule): DatabaseBackupSchedule {
    const now = new Date();
    const existing = schedules.value.find((schedule) => schedule.id === value.id);
    const normalized = normalizeDatabaseBackupSchedule(
      {
        ...value,
        createdAt: existing?.createdAt ?? value.createdAt,
        updatedAt: now.toISOString(),
      },
      now,
    );
    if (!normalized) throw new Error("Invalid database backup schedule");

    const timingChanged = !existing || existing.frequency !== normalized.frequency || existing.intervalHours !== normalized.intervalHours || existing.timeOfDay !== normalized.timeOfDay || existing.weekday !== normalized.weekday || (!existing.enabled && normalized.enabled);
    if (timingChanged) normalized.nextRunAt = nextDatabaseBackupRunAt(normalized, now).toISOString();
    if (existing) {
      normalized.lastRunAt = existing.lastRunAt;
      normalized.lastRunStatus = existing.lastRunStatus;
    }

    schedules.value = [...schedules.value.filter((schedule) => schedule.id !== normalized.id), normalized].sort((left, right) => left.name.localeCompare(right.name));
    persistSchedules();
    return normalized;
  }

  function setScheduleEnabled(scheduleId: string, enabled: boolean) {
    const schedule = schedules.value.find((item) => item.id === scheduleId);
    if (!schedule) return;
    saveSchedule({ ...schedule, enabled });
  }

  function deleteSchedule(scheduleId: string): boolean {
    if (activeScheduleIds.has(scheduleId)) return false;
    schedules.value = schedules.value.filter((schedule) => schedule.id !== scheduleId);
    persistSchedules();
    return true;
  }

  async function deleteRun(runId: string): Promise<void> {
    const run = runs.value.find((item) => item.id === runId);
    if (!run || activeRunIds.has(runId)) return;
    if (run.files.length > 0) await api.deleteDatabaseBackupFiles(run.files.map((file) => file.filePath));
    runs.value = runs.value.filter((item) => item.id !== runId);
    persistRuns();
  }

  async function pruneScheduleRuns(schedule: DatabaseBackupSchedule) {
    const staleRuns = databaseBackupRunsToPrune(runs.value, schedule.id, schedule.retentionCount);
    if (staleRuns.length === 0) return;
    const stalePaths = staleRuns.flatMap((run) => run.files.map((file) => file.filePath));
    try {
      if (stalePaths.length > 0) await api.deleteDatabaseBackupFiles(stalePaths);
      const staleIds = new Set(staleRuns.map((run) => run.id));
      runs.value = runs.value.filter((run) => !staleIds.has(run.id));
      persistRuns();
    } catch (error) {
      appendDebugLog("error", "[DBX][database-backup:retention-error]", error);
    }
  }

  async function cancelRun(runId: string) {
    if (!activeRunIds.has(runId)) return;
    cancellationRequested.add(runId);
    const exportId = activeExportIds.get(runId);
    if (exportId) await api.cancelDatabaseExport(exportId).catch(() => {});
  }

  async function runSchedule(scheduleId: string, trigger: DatabaseBackupRunTrigger = "manual"): Promise<DatabaseBackupRun | null> {
    if (!isTauriRuntime()) throw new Error("Scheduled database backups are only available in the desktop app.");
    const schedule = schedules.value.find((item) => item.id === scheduleId);
    if (!schedule || activeScheduleIds.has(scheduleId)) return null;
    const connection = connectionStore.getConfig(schedule.connectionId);

    const startedAt = new Date();
    const runId = generateDatabaseExportId();
    const run: DatabaseBackupRun = {
      id: runId,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      connectionId: schedule.connectionId,
      connectionName: connection?.name ?? "",
      trigger,
      status: "running",
      startedAt: startedAt.toISOString(),
      files: [],
    };
    replaceRun(run);
    activeScheduleIds.add(schedule.id);
    activeRunIds.add(runId);
    cancellationRequested.delete(runId);
    addDatabaseExportTask(runId, schedule.name, schedule.destinationDirectory);
    registerTaskCancelHandler(runId, () => cancelRun(runId));

    let finalStatus: Exclude<DatabaseBackupRunStatus, "running"> = "success";
    let finalError = "";
    let finishedRun: DatabaseBackupRun | null = null;
    const generatedPaths: string[] = [];
    try {
      if (!connection || !supportsScheduledDatabaseBackup(connection.db_type)) throw new Error("The backup connection is unavailable or unsupported.");
      await connectionStore.ensureConnected(schedule.connectionId);
      const availableDatabases = (await api.listDatabases(schedule.connectionId)).map((database) => database.name);
      const selectedDatabases = resolveScheduledDatabaseBackupTargets(schedule.databases, availableDatabases);
      if (selectedDatabases.length === 0) throw new Error("No databases are available for this backup schedule.");

      let exportIndex = 0;
      let totalExports = selectedDatabases.length;
      for (const database of selectedDatabases) {
        if (cancellationRequested.has(runId)) {
          finalStatus = "cancelled";
          break;
        }
        const snapshot = await api.beginDatabaseBackupSnapshot(schedule.connectionId, database);
        let snapshotCompleted = false;
        try {
          const databasePlan = buildAllDatabaseExportPlan({
            databases: [database],
            schemaAware: connection.db_type === "postgres",
            schemasByDatabase: { [database]: snapshot.schemas },
          });
          if (databasePlan.length === 0) throw new Error(`Database ${database} did not resolve to any schemas.`);
          totalExports += databasePlan.length - 1;

          for (const item of databasePlan) {
            if (cancellationRequested.has(runId)) {
              finalStatus = "cancelled";
              break;
            }
            exportIndex += 1;
            const childExportId = `${runId}-${exportIndex}`;
            activeExportIds.set(runId, childExportId);
            const filePath = databaseBackupFilePath(schedule.destinationDirectory, schedule.name, item.fileStem, startedAt, runId);
            generatedPaths.push(filePath);
            const terminal = await runDatabaseExportUntilTerminal(
              {
                exportId: childExportId,
                connectionId: schedule.connectionId,
                database: item.database,
                schema: item.schema,
                filePath,
                includeStructure: schedule.includeStructure,
                includeData: schedule.includeData,
                includeObjects: schedule.includeObjects,
                dropTableIfExists: schedule.dropTableIfExists,
                failOnError: true,
                snapshotSessionId: snapshot.sessionId,
                batchSize: 1000,
              },
              (progress) => {
                updateDatabaseExportTask(runId, {
                  ...progress,
                  exportId: runId,
                  currentObject: `${item.displayName}: ${progress.currentObject || item.displayName}`,
                  objectIndex: exportIndex - 1,
                  totalObjects: totalExports,
                });
              },
            );
            activeExportIds.delete(runId);
            if (terminal.status === "Cancelled" || cancellationRequested.has(runId)) {
              finalStatus = "cancelled";
              break;
            }

            const file: DatabaseBackupFile = {
              database: item.database,
              schema: item.schema,
              displayName: item.displayName,
              filePath,
            };
            run.files.push(file);
            updateRun(runId, { files: [...run.files] });
          }
          snapshotCompleted = finalStatus === "success";
        } finally {
          await api.rollbackManualTransaction(snapshot.sessionId).catch((error) => {
            if (snapshotCompleted) throw error;
          });
        }
        if (finalStatus !== "success") break;
      }
    } catch (error: any) {
      finalStatus = cancellationRequested.has(runId) ? "cancelled" : "failed";
      finalError = error?.message || String(error);
    } finally {
      if (finalStatus !== "success" && generatedPaths.length > 0) {
        try {
          await api.deleteDatabaseBackupFiles(generatedPaths);
          run.files = [];
        } catch (error: any) {
          appendDebugLog("error", "[DBX][database-backup:partial-cleanup-error]", error);
          const cleanupError = error?.message || String(error);
          finalError = finalError ? `${finalError}; failed to remove partial backup files: ${cleanupError}` : cleanupError;
        }
      }
      const completedAt = new Date();
      activeExportIds.delete(runId);
      cancellationRequested.delete(runId);
      activeScheduleIds.delete(schedule.id);
      activeRunIds.delete(runId);
      unregisterTaskCancelHandler(runId);

      finishedRun = updateRun(runId, {
        status: finalStatus,
        completedAt: completedAt.toISOString(),
        files: [...run.files],
        error: finalError || undefined,
      });
      updateDatabaseExportTask(runId, {
        exportId: runId,
        currentObject: schedule.name,
        objectIndex: finalStatus === "success" ? run.files.length : 0,
        totalObjects: run.files.length,
        rowsExported: 0,
        totalRows: null,
        status: finalStatus === "success" ? "Done" : finalStatus === "cancelled" ? "Cancelled" : "Error",
        error: finalError || null,
      });

      const latestSchedule = schedules.value.find((item) => item.id === schedule.id);
      if (latestSchedule) {
        schedules.value = schedules.value.map((item) =>
          item.id === schedule.id
            ? {
                ...item,
                lastRunAt: completedAt.toISOString(),
                lastRunStatus: finalStatus,
                nextRunAt: trigger === "scheduled" || Date.parse(item.nextRunAt) <= completedAt.getTime() ? nextDatabaseBackupRunAt(item, completedAt).toISOString() : item.nextRunAt,
              }
            : item,
        );
        persistSchedules();
        if (finalStatus === "success") await pruneScheduleRuns(latestSchedule);
      }

      appendDebugLog(finalStatus === "success" ? "info" : "error", `[DBX][database-backup:${finalStatus}]`, {
        scheduleId: schedule.id,
        runId,
        files: run.files.length,
        error: finalError || undefined,
      });
    }
    return finishedRun;
  }

  async function processDueSchedules() {
    if (processingDueSchedules) return;
    processingDueSchedules = true;
    try {
      await connectionStore.initFromDisk();
      const now = new Date();
      const dueSchedules = schedules.value.filter((schedule) => databaseBackupScheduleIsDue(schedule, now));
      for (const schedule of dueSchedules) {
        await runSchedule(schedule.id, "scheduled").catch((error) => {
          appendDebugLog("error", "[DBX][database-backup:scheduler-error]", error);
        });
      }
    } catch (error) {
      appendDebugLog("error", "[DBX][database-backup:scheduler-init-error]", error);
    } finally {
      processingDueSchedules = false;
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key && event.key !== DATABASE_BACKUP_SCHEDULES_STORAGE_KEY && event.key !== DATABASE_BACKUP_RUNS_STORAGE_KEY) return;
    refreshFromStorage();
    void processDueSchedules();
  }

  function onConfigChanged() {
    void processDueSchedules();
  }

  if (options.scheduler) {
    onMounted(() => {
      if (schedulerRegistered || !isTauriRuntime()) return;
      schedulerRegistered = true;
      window.addEventListener("storage", onStorage);
      window.addEventListener(DATABASE_BACKUP_CONFIG_CHANGED_EVENT, onConfigChanged);
      schedulerTimer = window.setInterval(() => void processDueSchedules(), SCHEDULER_INTERVAL_MS);
      void processDueSchedules();
    });

    onUnmounted(() => {
      if (!schedulerRegistered) return;
      schedulerRegistered = false;
      if (schedulerTimer) window.clearInterval(schedulerTimer);
      schedulerTimer = undefined;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(DATABASE_BACKUP_CONFIG_CHANGED_EVENT, onConfigChanged);
    });
  }

  return {
    schedules,
    runs,
    activeScheduleIds,
    activeRunIds,
    activeRuns,
    saveSchedule,
    setScheduleEnabled,
    deleteSchedule,
    deleteRun,
    runSchedule,
    cancelRun,
    processDueSchedules,
  };
}
