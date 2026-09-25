import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import * as api from "@/lib/backend/api";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { readDatabaseBackupRuns, readDatabaseBackupSchedules, type DatabaseBackupExecutionConfig, type DatabaseBackupRun, type DatabaseBackupSchedule } from "@/lib/backup/scheduledDatabaseBackup";
import type { DatabaseBackupSnapshot } from "@/lib/backup/backgroundDatabaseBackup";
import { useExportTracker } from "@/composables/useExportTracker";

const schedules = ref<DatabaseBackupSchedule[]>([]);
const runs = ref<DatabaseBackupRun[]>([]);
const activeScheduleIds = reactive(new Set<string>());
const activeRunIds = reactive(new Set<string>());
const cancellingRunIds = reactive(new Set<string>());
const heartbeat = ref<string | null>(null);
const destinationRoot = ref<string | null>(null);
const error = ref("");
const tracked = new Set<string>();
let refreshing: Promise<void> | undefined;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export function useScheduledDatabaseBackups(_options: { scheduler?: boolean } = {}) {
  const tracker = useExportTracker();
  const activeRuns = computed(() => runs.value.filter((run) => run.status === "running"));

  function update(snapshot: DatabaseBackupSnapshot) {
    schedules.value = snapshot.schedules;
    runs.value = snapshot.runs;
    heartbeat.value = snapshot.heartbeat;
    destinationRoot.value = snapshot.destinationRoot;
    activeScheduleIds.clear();
    activeRunIds.clear();
    for (const run of snapshot.runs) {
      if (run.status === "running") {
        activeRunIds.add(run.id);
        if (run.scheduleId) activeScheduleIds.add(run.scheduleId);
        if (!tracked.has(run.id)) {
          tracked.add(run.id);
          tracker.addDatabaseExportTask(run.id, run.displayName || run.scheduleName, run.destinationDirectory || "", run.source === "scheduled" ? "scheduled" : "manual");
          tracker.registerTaskCancelHandler(run.id, async () => {
            await cancelRun(run.id);
          });
        }
      } else {
        cancellingRunIds.delete(run.id);
        tracker.unregisterTaskCancelHandler(run.id);
      }
      if (tracked.has(run.id)) {
        tracker.updateDatabaseExportTask(run.id, {
          exportId: run.id,
          currentObject: run.displayName || run.scheduleName,
          objectIndex: 0,
          totalObjects: run.files.length,
          rowsExported: 0,
          totalRows: null,
          status: run.status === "running" ? "Running" : run.status === "success" ? "Done" : run.status === "cancelled" ? "Cancelled" : "Error",
          error: run.error || null,
          overallPercent: run.progressPercent || 0,
        });
        if (run.status !== "running") tracked.delete(run.id);
      }
    }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        let snapshot = await api.databaseBackupCommand<DatabaseBackupSnapshot>({ action: "snapshot" });
        if (!snapshot.migrated) {
          const legacySchedules = isTauriRuntime() ? readDatabaseBackupSchedules().map((schedule) => ({ ...schedule, timeZone: schedule.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone })) : [];
          await api.databaseBackupCommand({ action: "migrate", migration: { schedules: legacySchedules, runs: isTauriRuntime() ? readDatabaseBackupRuns() : [] } });
          // Keep legacy keys as a migration fallback. The backend marker prevents reimporting.
          snapshot = await api.databaseBackupCommand<DatabaseBackupSnapshot>({ action: "snapshot" });
        }
        update(snapshot);
        error.value = "";
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : String(reason);
        appendDebugLog("error", "[DBX][database-backup:refresh]", reason);
        throw reason;
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function refreshAfterMutation() {
    // A poll started before a mutation may still return the previous state.
    await refreshing?.catch(() => {});
    await refresh();
  }

  async function saveSchedule(schedule: DatabaseBackupSchedule) {
    const saved = await api.databaseBackupCommand<DatabaseBackupSchedule>({ action: "save", schedule: { ...schedule, timeZone: schedule.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone } });
    await refreshAfterMutation();
    return saved;
  }

  async function setScheduleEnabled(id: string, enabled: boolean) {
    const schedule = schedules.value.find((s) => s.id === id);
    if (schedule) await saveSchedule({ ...schedule, enabled });
  }

  async function deleteSchedule(id: string) {
    if (activeScheduleIds.has(id)) return false;
    await api.databaseBackupCommand({ action: "deleteSchedule", id });
    await refreshAfterMutation();
    return true;
  }

  async function deleteRuns(ids: readonly string[]) {
    await api.databaseBackupCommand({ action: "deleteRuns", ids: [...ids] });
    await refreshAfterMutation();
  }

  async function renameRun(id: string, name: string) {
    if (activeRunIds.has(id)) return false;
    await api.databaseBackupCommand({ action: "rename", id, name: name.trim() });
    await refreshAfterMutation();
    return true;
  }

  async function cancelRun(id: string) {
    const accepted = await api.databaseBackupCommand<boolean>({ action: "cancel", id });
    if (accepted) {
      cancellingRunIds.add(id);
      tracker.markDatabaseExportTaskCancelling(id);
    }
    return accepted;
  }

  async function waitForRun(run: DatabaseBackupRun): Promise<DatabaseBackupRun | null> {
    await refreshAfterMutation();
    while (true) {
      const current = runs.value.find((r) => r.id === run.id);
      if (!current || current.status !== "running") return current || null;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refresh();
    }
  }

  async function runSchedule(id: string) {
    if (activeScheduleIds.has(id)) return null;
    return waitForRun(await api.databaseBackupCommand<DatabaseBackupRun>({ action: "run", request: { scheduleId: id } }));
  }

  async function runOneShot(config: DatabaseBackupExecutionConfig, displayName = "Database backup") {
    return waitForRun(await api.databaseBackupCommand<DatabaseBackupRun>({ action: "run", request: { config, displayName, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }));
  }

  onMounted(() => {
    subscribers += 1;
    if (!timer)
      timer = setInterval(() => {
        void refresh().catch(() => {});
      }, 2000);
    void refresh().catch(() => {});
  });
  onUnmounted(() => {
    subscribers -= 1;
    if (!subscribers && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });

  return {
    schedules,
    runs,
    activeScheduleIds,
    activeRunIds,
    cancellingRunIds,
    activeRuns,
    heartbeat,
    destinationRoot,
    error,
    saveSchedule,
    setScheduleEnabled,
    deleteSchedule,
    deleteRuns,
    deleteRun: (id: string) => deleteRuns([id]),
    renameRun,
    runSchedule,
    runOneShot,
    cancelRun,
    processDueSchedules: refresh,
  };
}
