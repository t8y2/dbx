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
  DatabaseBackupConnectionQueue,
  databaseBackupAggregateExportStatus,
  databaseBackupFilePath,
  databaseBackupProgressPercent,
  databaseBackupRunsToPrune,
  databaseBackupScheduleIsDue,
  databaseBackupTableNamesAreCaseSensitive,
  nextDatabaseBackupRunAt,
  normalizeDatabaseBackupSchedule,
  readDatabaseBackupRuns,
  readDatabaseBackupSchedules,
  resolveScheduledDatabaseBackupTableScope,
  resolveScheduledDatabaseBackupTargets,
  supportsScheduledDatabaseBackup,
  toDatabaseBackupExecutionConfig,
  writeDatabaseBackupRuns,
  writeDatabaseBackupSchedules,
  type DatabaseBackupExecutionConfig,
  type DatabaseBackupFile,
  type DatabaseBackupRun,
  type DatabaseBackupRunSource,
  type DatabaseBackupRunStatus,
  type DatabaseBackupRunTrigger,
  type DatabaseBackupSchedule,
} from "@/lib/backup/scheduledDatabaseBackup";
import { useExportTracker } from "@/composables/useExportTracker";

const SCHEDULER_INTERVAL_MS = 30_000;
const databaseBackupConnectionQueue = new DatabaseBackupConnectionQueue();

const schedules = ref<DatabaseBackupSchedule[]>(readDatabaseBackupSchedules());
const runs = ref<DatabaseBackupRun[]>(readDatabaseBackupRuns());
const activeScheduleIds = reactive(new Set<string>());
const activeRunIds = reactive(new Set<string>());
const cancellingRunIds = reactive(new Set<string>());
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

function replaceRun(run: DatabaseBackupRun, persist = true) {
  runs.value = [run, ...runs.value.filter((existing) => existing.id !== run.id)];
  if (persist) persistRuns();
}

function updateRun(runId: string, patch: Partial<DatabaseBackupRun>, persist = true): DatabaseBackupRun | null {
  const existing = runs.value.find((run) => run.id === runId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  replaceRun(updated, persist);
  return updated;
}

type FinishedDatabaseBackupRun = Omit<DatabaseBackupRun, "status"> & { status: Exclude<DatabaseBackupRunStatus, "running"> };

function refreshFromStorage() {
  schedules.value = readDatabaseBackupSchedules();
  runs.value = readDatabaseBackupRuns();
}

export function useScheduledDatabaseBackups(options: { scheduler?: boolean } = {}) {
  const connectionStore = useConnectionStore();
  const { addDatabaseExportTask, markDatabaseExportTaskCancelling, registerTaskCancelHandler, restoreDatabaseExportTaskRunning, unregisterTaskCancelHandler, updateDatabaseExportTask } = useExportTracker();

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

  function renameRun(runId: string, displayName: string): boolean {
    const run = runs.value.find((item) => item.id === runId);
    if (!run || activeRunIds.has(runId)) return false;
    const normalizedName = displayName.trim();
    updateRun(runId, { displayName: normalizedName && normalizedName !== run.scheduleName ? normalizedName : undefined });
    return true;
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

  async function cancelRun(runId: string): Promise<boolean> {
    if (!activeRunIds.has(runId)) return false;
    if (cancellationRequested.has(runId)) return true;
    cancellationRequested.add(runId);
    cancellingRunIds.add(runId);
    markDatabaseExportTaskCancelling(runId);
    const exportIds = new Set([runId, activeExportIds.get(runId)].filter((id): id is string => Boolean(id)));
    try {
      await Promise.all([...exportIds].map((exportId) => api.cancelDatabaseExport(exportId)));
    } catch (error) {
      appendDebugLog("warn", "[DBX][database-backup:cancel-request-error]", error);
      cancellationRequested.delete(runId);
      cancellingRunIds.delete(runId);
      restoreDatabaseExportTaskRunning(runId);
      return false;
    }
    return true;
  }

  async function runBackup(config: DatabaseBackupExecutionConfig, request: { source: DatabaseBackupRunSource; trigger: DatabaseBackupRunTrigger; scheduleId?: string; displayName: string }): Promise<FinishedDatabaseBackupRun | null> {
    const backupName = request.displayName;
    const connection = connectionStore.getConfig(config.connectionId);

    const startedAt = new Date();
    const runId = generateDatabaseExportId();
    const run: DatabaseBackupRun = {
      id: runId,
      scheduleId: request.scheduleId,
      scheduleName: backupName,
      connectionId: config.connectionId,
      connectionName: connection?.name ?? "",
      trigger: request.trigger,
      source: request.source,
      status: "running",
      startedAt: startedAt.toISOString(),
      files: [],
      progressPercent: 0,
    };
    replaceRun(run);
    activeRunIds.add(runId);
    cancellationRequested.delete(runId);
    addDatabaseExportTask(runId, backupName, config.destinationDirectory, request.source === "scheduled" ? "scheduled" : "manual");
    registerTaskCancelHandler(runId, async () => {
      await cancelRun(runId);
    });

    let finalStatus: Exclude<DatabaseBackupRunStatus, "running"> = "success";
    let finalError = "";
    let finishedRun: FinishedDatabaseBackupRun | null = null;
    let lastProgressPercent = 0;
    const generatedPaths: string[] = [];
    await databaseBackupConnectionQueue.run(config.connectionId, async () => {
      try {
        if (cancellationRequested.has(runId)) {
          finalStatus = "cancelled";
          return;
        }
        if (!connection || !supportsScheduledDatabaseBackup(connection.db_type)) throw new Error("The backup connection is unavailable or unsupported.");
        await connectionStore.ensureConnected(config.connectionId);
        if (cancellationRequested.has(runId)) {
          finalStatus = "cancelled";
          return;
        }
        const availableDatabases = (await api.listDatabases(config.connectionId)).map((database) => database.name);
        if (cancellationRequested.has(runId)) {
          finalStatus = "cancelled";
          return;
        }
        const selectedDatabases = resolveScheduledDatabaseBackupTargets(config.databases, availableDatabases, connection.db_type);
        if (selectedDatabases.length === 0) throw new Error("No databases are available for this backup schedule.");

        let tableNamesCaseSensitive = true;
        if (connection.db_type === "mysql" && config.tableFilterMode !== "all") {
          try {
            const result = await api.executeQuery(config.connectionId, "", "SHOW VARIABLES LIKE 'lower_case_table_names'", undefined, undefined, { maxRows: 1 });
            tableNamesCaseSensitive = databaseBackupTableNamesAreCaseSensitive(connection.db_type, result.rows[0]?.[1] ?? result.rows[0]?.[0]);
          } catch (error) {
            appendDebugLog("warn", "[DBX][database-backup:table-name-case-detection-error]", error);
          }
          if (cancellationRequested.has(runId)) {
            finalStatus = "cancelled";
            return;
          }
        }

        let exportIndex = 0;
        let includedTableCount = 0;
        for (const [databaseIndex, database] of selectedDatabases.entries()) {
          if (cancellationRequested.has(runId)) {
            finalStatus = "cancelled";
            break;
          }
          const schemasByDatabase = connection.db_type === "postgres" ? { [database]: await api.listSchemas(config.connectionId, database) } : undefined;
          if (cancellationRequested.has(runId)) {
            finalStatus = "cancelled";
            break;
          }
          const databasePlan = buildAllDatabaseExportPlan({
            databases: [database],
            schemaAware: connection.db_type === "postgres",
            schemasByDatabase,
          });
          if (databasePlan.length === 0) throw new Error(`Database ${database} did not resolve to any schemas.`);
          const scopedDatabasePlan: Array<(typeof databasePlan)[number] & { selectedTables?: string[]; excludedTables?: string[] }> = [];
          for (const item of databasePlan) {
            if (config.tableFilterMode === "all") {
              scopedDatabasePlan.push(item);
              continue;
            }
            const availableTables = (await api.listTables(config.connectionId, item.database, item.schema)).map((table) => table.name);
            if (cancellationRequested.has(runId)) {
              finalStatus = "cancelled";
              break;
            }
            const scope = resolveScheduledDatabaseBackupTableScope(config.tableFilterMode, config.tablePatterns, availableTables, item.database, item.schema, tableNamesCaseSensitive);
            includedTableCount += scope.includedTables.length;
            if (scope.includedTables.length === 0) continue;
            scopedDatabasePlan.push({ ...item, selectedTables: scope.selectedTables, excludedTables: scope.excludedTables });
          }
          if (finalStatus === "cancelled") break;

          const snapshot = await api.beginDatabaseBackupSnapshot(config.connectionId, database, runId);
          let snapshotCompleted = false;
          try {
            for (const [planIndex, item] of scopedDatabasePlan.entries()) {
              if (cancellationRequested.has(runId)) {
                finalStatus = "cancelled";
                break;
              }
              exportIndex += 1;
              const childExportId = `${runId}-${exportIndex}`;
              activeExportIds.set(runId, childExportId);
              const filePath = databaseBackupFilePath(config.destinationDirectory, backupName, item.fileStem, startedAt, runId, config.outputCompression);
              generatedPaths.push(filePath);
              const terminal = await runDatabaseExportUntilTerminal(
                {
                  exportId: childExportId,
                  connectionId: config.connectionId,
                  database: item.database,
                  schema: item.schema,
                  filePath,
                  selectedTables: item.selectedTables,
                  excludedTables: item.excludedTables,
                  includeStructure: config.includeStructure,
                  includeData: config.includeData,
                  includeObjects: config.includeObjects,
                  dropTableIfExists: config.dropTableIfExists,
                  outputCompression: config.outputCompression,
                  failOnError: true,
                  snapshotSessionId: snapshot.sessionId,
                  batchSize: 1000,
                },
                (progress) => {
                  const progressPercent = databaseBackupProgressPercent({
                    completedDatabases: databaseIndex,
                    totalDatabases: selectedDatabases.length,
                    completedExports: planIndex,
                    totalExports: scopedDatabasePlan.length,
                    currentObjectIndex: progress.objectIndex,
                    currentTotalObjects: progress.totalObjects,
                    currentExportComplete: progress.status === "Done",
                  });
                  if (progressPercent !== lastProgressPercent) {
                    lastProgressPercent = progressPercent;
                    updateRun(runId, { progressPercent }, false);
                  }
                  updateDatabaseExportTask(runId, {
                    ...progress,
                    exportId: runId,
                    currentObject: `${item.displayName}: ${progress.currentObject || item.displayName}`,
                    status: databaseBackupAggregateExportStatus(progress.status, false),
                    overallPercent: progressPercent,
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
          lastProgressPercent = databaseBackupProgressPercent({
            completedDatabases: databaseIndex + 1,
            totalDatabases: selectedDatabases.length,
            completedExports: 0,
            totalExports: 0,
          });
          updateRun(runId, { progressPercent: lastProgressPercent }, false);
        }
        if (config.tableFilterMode !== "all" && includedTableCount === 0) {
          throw new Error(`No tables matched the configured ${config.tableFilterMode} backup rules.`);
        }
      } catch (error: any) {
        finalStatus = cancellationRequested.has(runId) ? "cancelled" : "failed";
        finalError = error?.message || String(error);
      } finally {
        // `runId` is also the cancellation key while a snapshot is waiting
        // for a pool connection. Unlike child exports, it has no exporter
        // task that can clear that key after completion.
        await api.clearDatabaseExportCancellation(runId).catch((error) => {
          appendDebugLog("warn", "[DBX][database-backup:cancel-clear-error]", error);
        });
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
        cancellingRunIds.delete(runId);
        activeRunIds.delete(runId);
        unregisterTaskCancelHandler(runId);

        const updatedRun = updateRun(runId, {
          status: finalStatus,
          completedAt: completedAt.toISOString(),
          files: [...run.files],
          progressPercent: finalStatus === "success" ? 100 : lastProgressPercent,
          error: finalError || undefined,
        });
        finishedRun = updatedRun && updatedRun.status !== "running" ? (updatedRun as FinishedDatabaseBackupRun) : null;
        updateDatabaseExportTask(runId, {
          exportId: runId,
          currentObject: backupName,
          objectIndex: finalStatus === "success" ? run.files.length : 0,
          totalObjects: run.files.length,
          rowsExported: 0,
          totalRows: null,
          status: databaseBackupAggregateExportStatus(finalStatus === "success" ? "Done" : finalStatus === "cancelled" ? "Cancelled" : "Error", true),
          error: finalError || null,
          overallPercent: finalStatus === "success" ? 100 : lastProgressPercent,
        });

        appendDebugLog(finalStatus === "success" ? "info" : "error", `[DBX][database-backup:${finalStatus}]`, {
          scheduleId: request.scheduleId,
          runId,
          files: run.files.length,
          error: finalError || undefined,
        });
      }
    });
    return finishedRun;
  }

  async function finalizeScheduledRun(scheduleId: string, trigger: DatabaseBackupRunTrigger, run: FinishedDatabaseBackupRun) {
    const schedule = schedules.value.find((item) => item.id === scheduleId);
    if (!schedule) return;
    const completedAt = run.completedAt ? new Date(run.completedAt) : new Date();
    schedules.value = schedules.value.map((item) =>
      item.id === scheduleId
        ? {
            ...item,
            lastRunAt: completedAt.toISOString(),
            lastRunStatus: run.status,
            nextRunAt: trigger === "scheduled" || Date.parse(item.nextRunAt) <= completedAt.getTime() ? nextDatabaseBackupRunAt(item, completedAt).toISOString() : item.nextRunAt,
          }
        : item,
    );
    persistSchedules();
    if (run.status === "success") await pruneScheduleRuns(schedule);
  }

  async function runSchedule(scheduleId: string, trigger: DatabaseBackupRunTrigger = "manual"): Promise<DatabaseBackupRun | null> {
    if (!isTauriRuntime()) throw new Error("Scheduled database backups are only available in the desktop app.");
    const schedule = schedules.value.find((item) => item.id === scheduleId);
    if (!schedule || activeScheduleIds.has(scheduleId)) return null;
    activeScheduleIds.add(scheduleId);
    try {
      const run = await runBackup(toDatabaseBackupExecutionConfig(schedule), { source: "scheduled", trigger, scheduleId, displayName: schedule.name });
      if (run) await finalizeScheduledRun(scheduleId, trigger, run);
      return run;
    } finally {
      activeScheduleIds.delete(scheduleId);
    }
  }

  async function runOneShot(config: DatabaseBackupExecutionConfig, displayName = "Database backup"): Promise<FinishedDatabaseBackupRun | null> {
    if (!isTauriRuntime()) throw new Error("One-shot database backups are only available in the desktop app.");
    if (activeRuns.value.some((run) => run.source === "one-shot")) return null;
    return runBackup(config, { source: "one-shot", trigger: "manual", displayName });
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
    cancellingRunIds,
    activeRuns,
    saveSchedule,
    setScheduleEnabled,
    deleteSchedule,
    deleteRun,
    renameRun,
    runSchedule,
    runOneShot,
    cancelRun,
    processDueSchedules,
  };
}
