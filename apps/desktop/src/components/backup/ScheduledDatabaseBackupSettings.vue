<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Check, ChevronDown, ChevronRight, DatabaseBackup, FolderOpen, Loader2, Pencil, Play, Plus, RotateCcw, Search, Square, Trash2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { useScheduledDatabaseBackups } from "@/composables/useScheduledDatabaseBackups";
import DatabaseBackupConfigFields from "@/components/backup/DatabaseBackupConfigFields.vue";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import { generateDatabaseExportId } from "@/lib/export/databaseExport";
import { nextDatabaseBackupRunAt, normalizeDatabaseBackupTablePatterns, supportsScheduledDatabaseBackup, type DatabaseBackupExecutionConfig, type DatabaseBackupFile, type DatabaseBackupRun, type DatabaseBackupSchedule } from "@/lib/backup/scheduledDatabaseBackup";
import { useConnectionStore } from "@/stores/connectionStore";
import { fetchNamespaceOptionsForConnection } from "@/composables/useDatabaseOptions";

const { t, locale } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const { schedules, runs, activeScheduleIds, activeRunIds, cancellingRunIds, activeRuns, saveSchedule, setScheduleEnabled, deleteSchedule, deleteRun, renameRun, runSchedule, runOneShot, cancelRun } = useScheduledDatabaseBackups();

const scheduleDialogOpen = ref(false);
const oneShotDialogOpen = ref(false);
const deleteScheduleDialogOpen = ref(false);
const deleteRunDialogOpen = ref(false);
const renameRunDialogOpen = ref(false);
const editingScheduleId = ref("");
const pendingDeleteSchedule = ref<DatabaseBackupSchedule | null>(null);
const pendingDeleteRun = ref<DatabaseBackupRun | null>(null);
const pendingRenameRun = ref<DatabaseBackupRun | null>(null);
const renameRunName = ref("");
const loadingDatabases = ref(false);
const saving = ref(false);
const oneShotStarting = ref(false);
const databaseOptions = ref<string[]>([]);
const allDatabases = ref(true);
const selectedDatabases = ref<string[]>([]);
const tablePatternsInput = ref("");
const expandedRunIds = reactive(new Set<string>());
const historyConnectionId = ref("");
const historyConnectionPickerOpen = ref(false);
const historyConnectionSearch = ref("");
const historyBackupMethod = ref<"all" | "manual" | "scheduled" | "one-shot">("all");
const historyStatus = ref<"all" | DatabaseBackupRun["status"]>("all");

const sqlConnections = computed(() => connectionStore.connections.filter((connection) => supportsScheduledDatabaseBackup(connection.db_type)));
const canCreateSchedule = computed(() => sqlConnections.value.length > 0);
const sortedRuns = computed(() => [...runs.value].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)));
const historyConnections = computed(() => {
  const connectionById = new Map<string, string>();
  for (const run of sortedRuns.value) {
    if (!connectionById.has(run.connectionId)) connectionById.set(run.connectionId, run.connectionName || connectionName(run.connectionId));
  }
  return [...connectionById].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, locale.value));
});
const filteredHistoryConnections = computed(() => {
  const query = historyConnectionSearch.value.trim().toLocaleLowerCase();
  if (!query) return historyConnections.value;
  return historyConnections.value.filter((connection) => connection.name.toLocaleLowerCase().includes(query));
});
const filteredRuns = computed(() =>
  sortedRuns.value.filter((run) => {
    if (historyConnectionId.value && run.connectionId !== historyConnectionId.value) return false;
    if (historyBackupMethod.value !== "all" && historyBackupMethod.value !== runBackupMethod(run)) return false;
    return historyStatus.value === "all" || historyStatus.value === run.status;
  }),
);
const selectedHistoryConnectionName = computed(() => historyConnections.value.find((connection) => connection.id === historyConnectionId.value)?.name || t("databaseBackup.allConnections"));
const weekdays = computed(() => [
  { value: 0, label: t("databaseBackup.weekdays.sunday") },
  { value: 1, label: t("databaseBackup.weekdays.monday") },
  { value: 2, label: t("databaseBackup.weekdays.tuesday") },
  { value: 3, label: t("databaseBackup.weekdays.wednesday") },
  { value: 4, label: t("databaseBackup.weekdays.thursday") },
  { value: 5, label: t("databaseBackup.weekdays.friday") },
  { value: 6, label: t("databaseBackup.weekdays.saturday") },
]);

watch(historyConnectionPickerOpen, (open) => {
  if (!open) historyConnectionSearch.value = "";
});

function newBackupConfig(connectionId = sqlConnections.value[0]?.id ?? ""): DatabaseBackupExecutionConfig {
  return {
    connectionId,
    databases: [],
    tableFilterMode: "all",
    tablePatterns: [],
    destinationDirectory: "",
    includeStructure: true,
    includeData: true,
    includeObjects: true,
    dropTableIfExists: false,
    outputCompression: "none",
  };
}

function newScheduleDraft(connectionId = sqlConnections.value[0]?.id ?? ""): DatabaseBackupSchedule {
  const now = new Date();
  const draft: DatabaseBackupSchedule = {
    ...newBackupConfig(connectionId),
    id: generateDatabaseExportId(),
    name: t("databaseBackup.defaultScheduleName"),
    enabled: true,
    frequency: "daily",
    intervalHours: 6,
    timeOfDay: "02:00",
    weekday: 1,
    retentionCount: 10,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: "",
  };
  draft.nextRunAt = nextDatabaseBackupRunAt(draft, now).toISOString();
  return draft;
}

const draft = ref<DatabaseBackupSchedule>(newScheduleDraft());
const oneShotDraft = ref<DatabaseBackupExecutionConfig>(newBackupConfig());
const activeDraft = computed<DatabaseBackupExecutionConfig>(() => (oneShotDialogOpen.value ? oneShotDraft.value : draft.value));
const activeOneShotRun = computed(() => activeRuns.value.find((run) => run.source === "one-shot"));
type BackupDialogKind = "schedule" | "one-shot";
let databaseLoadGeneration = 0;

function databaseLoadIsCurrent(generation: number, dialog: BackupDialogKind, targetDraft: DatabaseBackupExecutionConfig, connectionId: string): boolean {
  if (generation !== databaseLoadGeneration) return false;
  if (dialog === "one-shot") return oneShotDialogOpen.value && oneShotDraft.value === targetDraft && targetDraft.connectionId === connectionId;
  return scheduleDialogOpen.value && draft.value === targetDraft && targetDraft.connectionId === connectionId;
}

const canSave = computed(() => {
  const hasContent = draft.value.includeStructure || draft.value.includeData || draft.value.includeObjects;
  const hasDatabaseScope = allDatabases.value || selectedDatabases.value.length > 0;
  const hasTableScope = draft.value.tableFilterMode === "all" || normalizeDatabaseBackupTablePatterns(tablePatternsInput.value).length > 0;
  return !!draft.value.name.trim() && !!draft.value.connectionId && !!draft.value.destinationDirectory.trim() && hasContent && hasDatabaseScope && hasTableScope && !saving.value && !loadingDatabases.value;
});
const nextRunPreview = computed(() => nextDatabaseBackupRunAt(draft.value, new Date()));
const canStartOneShot = computed(() => {
  const hasContent = oneShotDraft.value.includeStructure || oneShotDraft.value.includeData || oneShotDraft.value.includeObjects;
  const hasDatabaseScope = allDatabases.value || selectedDatabases.value.length > 0;
  const hasTableScope = oneShotDraft.value.tableFilterMode === "all" || normalizeDatabaseBackupTablePatterns(tablePatternsInput.value).length > 0;
  return !!oneShotDraft.value.connectionId && !!oneShotDraft.value.destinationDirectory.trim() && hasContent && hasDatabaseScope && hasTableScope && !oneShotStarting.value && !loadingDatabases.value;
});

function connectionName(connectionId: string): string {
  return connectionStore.getConfig(connectionId)?.name || t("databaseBackup.missingConnection");
}

function selectHistoryConnection(connectionId: string) {
  historyConnectionId.value = connectionId;
  historyConnectionPickerOpen.value = false;
  historyConnectionSearch.value = "";
}

function runBackupMethod(run: DatabaseBackupRun): "manual" | "scheduled" | "one-shot" {
  if (run.source === "one-shot") return "one-shot";
  return run.trigger;
}

function formatDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("databaseBackup.never");
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function frequencyLabel(schedule: DatabaseBackupSchedule): string {
  if (schedule.frequency === "hourly") return t("databaseBackup.everyHours", { count: schedule.intervalHours });
  if (schedule.frequency === "daily") return t("databaseBackup.dailyAt", { time: schedule.timeOfDay });
  return t("databaseBackup.weeklyAt", {
    weekday: weekdays.value.find((item) => item.value === schedule.weekday)?.label ?? "",
    time: schedule.timeOfDay,
  });
}

function databaseScopeLabel(schedule: DatabaseBackupSchedule): string {
  if (schedule.databases.length === 0) return t("databaseBackup.allDatabases");
  if (schedule.databases.length === 1) return schedule.databases[0]!;
  return t("databaseBackup.databaseCount", { count: schedule.databases.length });
}

function tableScopeLabel(schedule: DatabaseBackupSchedule): string {
  if (schedule.tableFilterMode === "include") return t("databaseBackup.includedTablePatterns", { count: schedule.tablePatterns.length });
  if (schedule.tableFilterMode === "exclude") return t("databaseBackup.excludedTablePatterns", { count: schedule.tablePatterns.length });
  return "";
}

function runStatusLabel(status: DatabaseBackupRun["status"]): string {
  return t(`databaseBackup.status.${status}`);
}

function displayedRunStatusLabel(run: DatabaseBackupRun): string {
  return cancellingRunIds.has(run.id) ? t("databaseBackup.cancelling") : runStatusLabel(run.status);
}

function runStatusVariant(status: DatabaseBackupRun["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "success") return "default";
  if (status === "failed") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

function activeRunForSchedule(scheduleId: string): DatabaseBackupRun | undefined {
  return activeRuns.value.find((run) => run.scheduleId === scheduleId);
}

function scheduleCancellationRequested(scheduleId: string): boolean {
  const run = activeRunForSchedule(scheduleId);
  return !!run && cancellingRunIds.has(run.id);
}

function oneShotCancellationRequested(): boolean {
  return !!activeOneShotRun.value && cancellingRunIds.has(activeOneShotRun.value.id);
}

async function loadDatabases(dialog: BackupDialogKind, targetDraft: DatabaseBackupExecutionConfig, preserveSelection: boolean) {
  const generation = ++databaseLoadGeneration;
  const connectionId = targetDraft.connectionId;
  databaseOptions.value = [];
  if (!preserveSelection) {
    selectedDatabases.value = [];
    allDatabases.value = true;
    targetDraft.tableFilterMode = "all";
    targetDraft.tablePatterns = [];
    tablePatternsInput.value = "";
  }
  if (!connectionId) {
    loadingDatabases.value = false;
    return;
  }
  loadingDatabases.value = true;
  try {
    await connectionStore.ensureConnected(connectionId);
    const config = connectionStore.getConfig(connectionId);
    const names = config?.db_type === "dameng" ? await fetchNamespaceOptionsForConnection(connectionId, config) : (await api.listDatabases(connectionId)).map((database) => database.name);
    if (!databaseLoadIsCurrent(generation, dialog, targetDraft, connectionId)) return;
    databaseOptions.value = names;
    if (preserveSelection) {
      const selected = new Set(selectedDatabases.value);
      selectedDatabases.value = names.filter((database) => selected.has(database));
    }
  } catch (error: any) {
    if (databaseLoadIsCurrent(generation, dialog, targetDraft, connectionId)) toast(error?.message || String(error), 5000);
  } finally {
    if (generation === databaseLoadGeneration) loadingDatabases.value = false;
  }
}

async function openCreateSchedule() {
  oneShotDialogOpen.value = false;
  editingScheduleId.value = "";
  const nextDraft = newScheduleDraft();
  draft.value = nextDraft;
  allDatabases.value = true;
  selectedDatabases.value = [];
  tablePatternsInput.value = "";
  scheduleDialogOpen.value = true;
  await loadDatabases("schedule", draft.value, false);
}

async function openEditSchedule(schedule: DatabaseBackupSchedule) {
  oneShotDialogOpen.value = false;
  editingScheduleId.value = schedule.id;
  draft.value = { ...schedule, databases: [...schedule.databases], tablePatterns: [...schedule.tablePatterns] };
  allDatabases.value = schedule.databases.length === 0;
  selectedDatabases.value = [...schedule.databases];
  tablePatternsInput.value = schedule.tablePatterns.join(", ");
  scheduleDialogOpen.value = true;
  await loadDatabases("schedule", draft.value, true);
}

async function changeConnection(connectionId: string) {
  const dialog: BackupDialogKind = oneShotDialogOpen.value ? "one-shot" : "schedule";
  const targetDraft = dialog === "one-shot" ? oneShotDraft.value : draft.value;
  targetDraft.connectionId = connectionId;
  await loadDatabases(dialog, targetDraft, false);
}

function toggleDatabase(database: string) {
  const selected = new Set(selectedDatabases.value);
  if (selected.has(database)) selected.delete(database);
  else selected.add(database);
  selectedDatabases.value = databaseOptions.value.filter((item) => selected.has(item));
}

async function chooseDestination() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: t("databaseBackup.selectDestination") });
  if (typeof selected === "string") activeDraft.value.destinationDirectory = selected;
}

async function submitSchedule() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    await api.recordDatabaseExportDestination(draft.value.destinationDirectory);
    saveSchedule({
      ...draft.value,
      databases: allDatabases.value ? [] : [...selectedDatabases.value],
      tablePatterns: draft.value.tableFilterMode === "all" ? [] : normalizeDatabaseBackupTablePatterns(tablePatternsInput.value),
    });
    scheduleDialogOpen.value = false;
    toast(t(editingScheduleId.value ? "databaseBackup.scheduleUpdated" : "databaseBackup.scheduleCreated"), 2500);
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  } finally {
    saving.value = false;
  }
}

async function openOneShotBackup() {
  scheduleDialogOpen.value = false;
  const nextDraft = newBackupConfig();
  oneShotDraft.value = nextDraft;
  allDatabases.value = true;
  selectedDatabases.value = [];
  tablePatternsInput.value = "";
  oneShotDialogOpen.value = true;
  await loadDatabases("one-shot", oneShotDraft.value, false);
}

async function startOneShotBackup() {
  if (!canStartOneShot.value) return;
  oneShotStarting.value = true;
  try {
    await api.recordDatabaseExportDestination(oneShotDraft.value.destinationDirectory);
    const run = await runOneShot(
      {
        ...oneShotDraft.value,
        databases: allDatabases.value ? [] : [...selectedDatabases.value],
        tablePatterns: oneShotDraft.value.tableFilterMode === "all" ? [] : normalizeDatabaseBackupTablePatterns(tablePatternsInput.value),
      },
      t("databaseBackup.oneShotName"),
    );
    if (!run) return;
    oneShotDialogOpen.value = false;
    if (run.status === "success") toast(t("databaseBackup.runSuccess", { count: run.files.length }), 3000);
    else if (run.status === "cancelled") toast(t("databaseBackup.runCancelled"), 3000);
    else toast(t("databaseBackup.runFailed", { error: run.error ? translateBackendError(t, run.error) : t("databaseBackup.unknownError") }), 5000);
  } catch (error: any) {
    toast(translateBackendError(t, error), 5000);
  } finally {
    oneShotStarting.value = false;
  }
}

async function cancelActiveOneShotBackup() {
  const run = activeOneShotRun.value;
  if (run && (await cancelRun(run.id))) toast(t("databaseBackup.cancelRequested"), 2500);
}

async function requestCancelRun(runId: string) {
  if (await cancelRun(runId)) toast(t("databaseBackup.cancelRequested"), 2500);
}

async function runNow(schedule: DatabaseBackupSchedule) {
  try {
    const run = await runSchedule(schedule.id, "manual");
    if (!run) return;
    if (run.status === "success") toast(t("databaseBackup.runSuccess", { count: run.files.length }), 3000);
    else if (run.status === "cancelled") toast(t("databaseBackup.runCancelled"), 3000);
    else toast(t("databaseBackup.runFailed", { error: run.error ? translateBackendError(t, run.error) : t("databaseBackup.unknownError") }), 5000);
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

function requestDeleteSchedule(schedule: DatabaseBackupSchedule) {
  pendingDeleteSchedule.value = schedule;
  deleteScheduleDialogOpen.value = true;
}

function confirmDeleteSchedule() {
  if (!pendingDeleteSchedule.value) return;
  if (!deleteSchedule(pendingDeleteSchedule.value.id)) {
    toast(t("databaseBackup.cannotDeleteRunningSchedule"), 3000);
    return;
  }
  deleteScheduleDialogOpen.value = false;
  pendingDeleteSchedule.value = null;
}

function requestDeleteRun(run: DatabaseBackupRun) {
  pendingDeleteRun.value = run;
  deleteRunDialogOpen.value = true;
}

function requestRenameRun(run: DatabaseBackupRun) {
  if (activeRunIds.has(run.id)) return;
  pendingRenameRun.value = run;
  renameRunName.value = run.displayName || run.scheduleName;
  renameRunDialogOpen.value = true;
}

function confirmRenameRun() {
  const run = pendingRenameRun.value;
  if (!run || !renameRunName.value.trim()) return;
  if (!renameRun(run.id, renameRunName.value)) return;
  renameRunDialogOpen.value = false;
  pendingRenameRun.value = null;
  toast(t("databaseBackup.backupRenamed"), 2500);
}

async function confirmDeleteRun() {
  const run = pendingDeleteRun.value;
  if (!run) return;
  try {
    await deleteRun(run.id);
    deleteRunDialogOpen.value = false;
    pendingDeleteRun.value = null;
    toast(t("databaseBackup.backupDeleted"), 2500);
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

function toggleRunExpanded(runId: string) {
  if (expandedRunIds.has(runId)) expandedRunIds.delete(runId);
  else expandedRunIds.add(runId);
}

async function revealBackup(file: DatabaseBackupFile) {
  try {
    await api.revealPathInFileManager(file.filePath);
  } catch (error: any) {
    toast(translateBackendError(t, error), 5000);
  }
}

function restoreBackup(run: DatabaseBackupRun, file: DatabaseBackupFile) {
  connectionStore.sqlFileSource = {
    connectionId: run.connectionId,
    database: file.database,
    filePath: file.filePath,
  };
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold">{{ t("databaseBackup.schedules") }}</h3>
        <p class="mt-1 text-sm text-muted-foreground">{{ t("databaseBackup.runtimeRequirement") }}</p>
        <p v-if="!canCreateSchedule" class="mt-1 text-xs text-muted-foreground">{{ t("databaseBackup.noSupportedConnections") }}</p>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" :disabled="!canCreateSchedule" :title="canCreateSchedule ? t('databaseBackup.oneShotBackup') : t('databaseBackup.noSupportedConnections')" @click="openOneShotBackup">
          <Play class="mr-2 h-4 w-4" />
          {{ t("databaseBackup.oneShotBackup") }}
        </Button>
        <Button size="sm" :disabled="!canCreateSchedule" :title="canCreateSchedule ? t('databaseBackup.addSchedule') : t('databaseBackup.noSupportedConnections')" @click="openCreateSchedule">
          <Plus class="mr-2 h-4 w-4" />
          {{ t("databaseBackup.addSchedule") }}
        </Button>
      </div>
    </div>

    <div class="overflow-hidden rounded-md border border-border/70">
      <div v-if="schedules.length === 0" class="flex min-h-44 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground">
        <DatabaseBackup class="h-8 w-8 opacity-60" />
        <div>
          <div class="text-sm font-medium text-foreground">{{ t("databaseBackup.noSchedules") }}</div>
          <p class="mt-1 text-sm">{{ t("databaseBackup.noSchedulesHint") }}</p>
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" :disabled="!canCreateSchedule" @click="openOneShotBackup"><Play class="mr-2 h-4 w-4" />{{ t("databaseBackup.oneShotBackup") }}</Button>
          <Button size="sm" :disabled="!canCreateSchedule" @click="openCreateSchedule"><Plus class="mr-2 h-4 w-4" />{{ t("databaseBackup.addSchedule") }}</Button>
        </div>
      </div>
      <div v-for="schedule in schedules" :key="schedule.id" class="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate text-sm font-medium">{{ schedule.name }}</span>
            <Badge variant="outline" class="font-normal">{{ connectionName(schedule.connectionId) }}</Badge>
            <Badge v-if="activeScheduleIds.has(schedule.id)" variant="secondary" class="font-normal">{{ scheduleCancellationRequested(schedule.id) ? t("databaseBackup.cancelling") : t("databaseBackup.status.running") }}</Badge>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{{ frequencyLabel(schedule) }}</span>
            <span>{{ databaseScopeLabel(schedule) }}</span>
            <span v-if="schedule.tableFilterMode !== 'all'">{{ tableScopeLabel(schedule) }}</span>
            <span>{{ t("databaseBackup.nextRun", { time: formatDate(schedule.nextRunAt) }) }}</span>
            <span>{{ t("databaseBackup.keepRuns", { count: schedule.retentionCount }) }}</span>
          </div>
        </div>
        <div class="flex items-center justify-end gap-1">
          <Switch :model-value="schedule.enabled" :disabled="activeScheduleIds.has(schedule.id)" :title="schedule.enabled ? t('databaseBackup.disable') : t('databaseBackup.enable')" @update:model-value="(value: boolean) => setScheduleEnabled(schedule.id, value)" />
          <Button
            v-if="activeRunForSchedule(schedule.id)"
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            :disabled="scheduleCancellationRequested(schedule.id)"
            :title="scheduleCancellationRequested(schedule.id) ? t('databaseBackup.cancelling') : t('databaseBackup.cancel')"
            @click="requestCancelRun(activeRunForSchedule(schedule.id)!.id)"
          >
            <Loader2 v-if="scheduleCancellationRequested(schedule.id)" class="h-4 w-4 animate-spin" />
            <Square v-else class="h-4 w-4" />
          </Button>
          <Button v-else variant="ghost" size="icon" class="h-8 w-8" :title="t('databaseBackup.runNow')" @click="runNow(schedule)">
            <Play class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="activeScheduleIds.has(schedule.id)" :title="t('databaseBackup.edit')" @click="openEditSchedule(schedule)">
            <Pencil class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-destructive" :disabled="activeScheduleIds.has(schedule.id)" :title="t('databaseBackup.delete')" @click="requestDeleteSchedule(schedule)">
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-base font-semibold">{{ t("databaseBackup.history") }}</h3>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Popover v-model:open="historyConnectionPickerOpen">
            <PopoverTrigger as-child>
              <Button data-backup-history-connection-picker type="button" variant="outline" role="combobox" :aria-expanded="historyConnectionPickerOpen" class="min-w-52 justify-between font-normal">
                <span class="truncate">{{ selectedHistoryConnectionName }}</span>
                <ChevronDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-[var(--reka-popover-trigger-width)] p-1">
              <div class="relative">
                <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="historyConnectionSearch" data-backup-history-connection-search class="h-9 pl-8" :aria-label="t('databaseBackup.searchHistoryConnections')" :placeholder="t('databaseBackup.searchHistoryConnections')" />
              </div>
              <div class="max-h-60 overflow-y-auto py-1">
                <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none" @click="selectHistoryConnection('')">
                  <Check class="h-4 w-4 shrink-0" :class="historyConnectionId ? 'opacity-0' : 'opacity-100'" />
                  <span class="min-w-0 flex-1 truncate">{{ t("databaseBackup.allConnections") }}</span>
                </button>
                <button
                  v-for="connection in filteredHistoryConnections"
                  :key="connection.id"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                  @click="selectHistoryConnection(connection.id)"
                >
                  <Check class="h-4 w-4 shrink-0" :class="connection.id === historyConnectionId ? 'opacity-100' : 'opacity-0'" />
                  <span class="min-w-0 flex-1 truncate">{{ connection.name }}</span>
                </button>
                <div v-if="filteredHistoryConnections.length === 0" class="px-2 py-2 text-sm text-muted-foreground">{{ t("databaseBackup.noMatchingConnections") }}</div>
              </div>
            </PopoverContent>
          </Popover>
          <Select v-model="historyBackupMethod">
            <SelectTrigger class="w-36" :aria-label="t('databaseBackup.backupMethod')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("databaseBackup.allBackupMethods") }}</SelectItem>
              <SelectItem value="manual">{{ t("databaseBackup.manualTrigger") }}</SelectItem>
              <SelectItem value="scheduled">{{ t("databaseBackup.scheduledTrigger") }}</SelectItem>
              <SelectItem value="one-shot">{{ t("databaseBackup.oneShotTrigger") }}</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="historyStatus">
            <SelectTrigger class="w-32" :aria-label="t('databaseBackup.backupStatus')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("databaseBackup.allStatuses") }}</SelectItem>
              <SelectItem value="running">{{ t("databaseBackup.status.running") }}</SelectItem>
              <SelectItem value="success">{{ t("databaseBackup.status.success") }}</SelectItem>
              <SelectItem value="failed">{{ t("databaseBackup.status.failed") }}</SelectItem>
              <SelectItem value="cancelled">{{ t("databaseBackup.status.cancelled") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div class="overflow-hidden rounded-md border border-border/70">
        <div v-if="filteredRuns.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ historyConnectionId || historyBackupMethod !== "all" || historyStatus !== "all" ? t("databaseBackup.noFilteredHistory") : t("databaseBackup.noHistory") }}</div>
        <template v-for="run in filteredRuns" :key="run.id">
          <div class="grid gap-2 border-b border-border/70 px-3 py-3 last:border-b-0 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="run.files.length === 0" :title="t('databaseBackup.showFiles')" @click="toggleRunExpanded(run.id)">
              <ChevronDown v-if="expandedRunIds.has(run.id)" class="h-4 w-4" />
              <ChevronRight v-else class="h-4 w-4" />
            </Button>
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="truncate text-sm font-medium">{{ run.displayName || run.scheduleName }}</span>
                <Badge :variant="runStatusVariant(run.status)" class="font-normal">{{ displayedRunStatusLabel(run) }}</Badge>
                <Badge variant="outline" class="font-normal">{{ run.source === "one-shot" ? t("databaseBackup.oneShotTrigger") : run.trigger === "scheduled" ? t("databaseBackup.scheduledTrigger") : t("databaseBackup.manualTrigger") }}</Badge>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{{ run.connectionName || connectionName(run.connectionId) }}</span>
                <span>{{ formatDate(run.startedAt) }}</span>
                <span>{{ t("databaseBackup.fileCount", { count: run.files.length }) }}</span>
                <span v-if="run.error" class="break-all text-destructive">{{ translateBackendError(t, run.error) }}</span>
              </div>
              <div v-if="activeRunIds.has(run.id)" class="mt-2 flex items-center gap-2">
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-label="t('databaseBackup.progress')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="run.progressPercent ?? 0">
                  <div class="h-full rounded-full bg-primary transition-[width] duration-300" :style="{ width: `${run.progressPercent ?? 0}%` }" />
                </div>
                <span class="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{{ run.progressPercent ?? 0 }}%</span>
              </div>
            </div>
            <div class="flex items-center justify-end gap-1">
              <Button
                v-if="activeRunIds.has(run.id) && run.source === 'one-shot'"
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                :disabled="cancellingRunIds.has(run.id)"
                :title="cancellingRunIds.has(run.id) ? t('databaseBackup.cancelling') : t('databaseBackup.cancel')"
                @click="requestCancelRun(run.id)"
              >
                <Loader2 v-if="cancellingRunIds.has(run.id)" class="h-4 w-4 animate-spin" />
                <Square v-else class="h-4 w-4" />
              </Button>
              <Loader2 v-else-if="activeRunIds.has(run.id)" class="mr-2 h-4 w-4 animate-spin text-primary" />
              <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="activeRunIds.has(run.id)" :title="t('databaseBackup.renameBackup')" @click="requestRenameRun(run)">
                <Pencil class="h-4 w-4" />
              </Button>
              <Button v-if="run.files[0]" variant="ghost" size="icon" class="h-8 w-8" :title="t('databaseBackup.revealFile')" @click="revealBackup(run.files[0])">
                <FolderOpen class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-destructive" :disabled="activeRunIds.has(run.id)" :title="t('databaseBackup.deleteBackup')" @click="requestDeleteRun(run)">
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div v-if="expandedRunIds.has(run.id) && run.files.length > 0" class="border-b border-border/70 bg-muted/20 px-4 py-2 last:border-b-0">
            <div v-for="file in run.files" :key="file.filePath" class="grid gap-2 border-b border-border/50 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div class="min-w-0">
                <div class="truncate text-xs font-medium">{{ file.displayName }}</div>
                <div class="truncate text-xs text-muted-foreground" :title="file.filePath">{{ file.filePath }}</div>
              </div>
              <div class="flex items-center justify-end gap-1">
                <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('databaseBackup.revealFile')" @click="revealBackup(file)">
                  <FolderOpen class="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="sm" class="h-7" @click="restoreBackup(run, file)">
                  <RotateCcw class="mr-1.5 h-3.5 w-3.5" />
                  {{ t("databaseBackup.restore") }}
                </Button>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <Dialog v-model:open="scheduleDialogOpen">
    <DialogContent class="dbx-form-dialog dbx-form-dialog--lg max-h-[min(760px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(720px,calc(100vw-32px))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ editingScheduleId ? t("databaseBackup.editSchedule") : t("databaseBackup.addSchedule") }}</DialogTitle>
      </DialogHeader>

      <div class="grid gap-5 py-1">
        <div class="space-y-2">
          <Label>{{ t("databaseBackup.scheduleName") }}</Label>
          <Input v-model="draft.name" />
        </div>

        <DatabaseBackupConfigFields
          :draft="draft"
          :connections="sqlConnections"
          :all-databases="allDatabases"
          :selected-databases="selectedDatabases"
          :database-options="databaseOptions"
          :table-patterns-input="tablePatternsInput"
          :loading-databases="loadingDatabases"
          @change-connection="changeConnection"
          @choose-destination="chooseDestination"
          @toggle-database="toggleDatabase"
          @update:all-databases="(value: boolean) => (allDatabases = value)"
          @update:table-patterns-input="(value: string) => (tablePatternsInput = value)"
        />

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-2">
            <Label>{{ t("databaseBackup.frequency") }}</Label>
            <Select v-model="draft.frequency">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">{{ t("databaseBackup.frequencyHourly") }}</SelectItem>
                <SelectItem value="daily">{{ t("databaseBackup.frequencyDaily") }}</SelectItem>
                <SelectItem value="weekly">{{ t("databaseBackup.frequencyWeekly") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="draft.frequency === 'hourly'" class="space-y-2">
            <Label>{{ t("databaseBackup.intervalHours") }}</Label>
            <Input v-model.number="draft.intervalHours" type="number" min="1" max="168" />
          </div>
          <div v-else class="space-y-2">
            <Label>{{ t("databaseBackup.time") }}</Label>
            <Input v-model="draft.timeOfDay" type="time" />
          </div>
          <div v-if="draft.frequency === 'weekly'" class="space-y-2">
            <Label>{{ t("databaseBackup.weekday") }}</Label>
            <Select :model-value="String(draft.weekday)" @update:model-value="(value: any) => (draft.weekday = Number(value))">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="weekday in weekdays" :key="weekday.value" :value="String(weekday.value)">{{ weekday.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-2">
            <Label>{{ t("databaseBackup.retention") }}</Label>
            <Input v-model.number="draft.retentionCount" type="number" min="1" max="100" />
          </div>
        </div>
        <div class="text-xs text-muted-foreground">{{ t("databaseBackup.nextRunPreview", { time: formatDate(nextRunPreview.toISOString()) }) }}</div>

        <div class="flex items-center justify-between gap-4 border-t border-border/70 pt-4">
          <div>
            <Label>{{ t("databaseBackup.enabled") }}</Label>
            <div class="mt-1 text-xs text-muted-foreground">{{ t("databaseBackup.enabledHint") }}</div>
          </div>
          <Switch v-model="draft.enabled" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="scheduleDialogOpen = false">{{ t("common.cancel") }}</Button>
        <Button :disabled="!canSave" @click="submitSchedule">
          <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
          {{ t("common.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="oneShotDialogOpen">
    <DialogContent class="dbx-form-dialog dbx-form-dialog--lg max-h-[min(760px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(720px,calc(100vw-32px))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ t("databaseBackup.oneShotBackup") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">{{ t("databaseBackup.oneShotDescription") }}</p>
      </DialogHeader>

      <DatabaseBackupConfigFields
        :draft="oneShotDraft"
        :connections="sqlConnections"
        :all-databases="allDatabases"
        :selected-databases="selectedDatabases"
        :database-options="databaseOptions"
        :table-patterns-input="tablePatternsInput"
        :loading-databases="loadingDatabases"
        @change-connection="changeConnection"
        @choose-destination="chooseDestination"
        @toggle-database="toggleDatabase"
        @update:all-databases="(value: boolean) => (allDatabases = value)"
        @update:table-patterns-input="(value: string) => (tablePatternsInput = value)"
      />

      <DialogFooter>
        <Button variant="outline" @click="oneShotDialogOpen = false">{{ oneShotStarting ? t("common.close") : t("common.cancel") }}</Button>
        <Button v-if="oneShotStarting" variant="destructive" :disabled="!activeOneShotRun || oneShotCancellationRequested()" :title="oneShotCancellationRequested() ? t('databaseBackup.cancelling') : t('databaseBackup.cancel')" @click="cancelActiveOneShotBackup">
          <Loader2 v-if="oneShotCancellationRequested()" class="mr-2 h-4 w-4 animate-spin" />
          <Square v-else class="mr-2 h-4 w-4" />
          {{ oneShotCancellationRequested() ? t("databaseBackup.cancelling") : t("databaseBackup.cancel") }}
        </Button>
        <Button v-else :disabled="!canStartOneShot" @click="startOneShotBackup">
          {{ t("databaseBackup.startBackup") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="deleteScheduleDialogOpen">
    <DialogContent class="max-w-md">
      <DialogHeader
        ><DialogTitle>{{ t("databaseBackup.deleteSchedule") }}</DialogTitle></DialogHeader
      >
      <p class="text-sm text-muted-foreground">{{ t("databaseBackup.deleteScheduleConfirm", { name: pendingDeleteSchedule?.name || "" }) }}</p>
      <DialogFooter>
        <Button variant="outline" @click="deleteScheduleDialogOpen = false">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteSchedule">{{ t("databaseBackup.delete") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="deleteRunDialogOpen">
    <DialogContent class="max-w-md">
      <DialogHeader
        ><DialogTitle>{{ t("databaseBackup.deleteBackup") }}</DialogTitle></DialogHeader
      >
      <p class="text-sm text-muted-foreground">{{ t("databaseBackup.deleteBackupConfirm", { count: pendingDeleteRun?.files.length || 0 }) }}</p>
      <DialogFooter>
        <Button variant="outline" @click="deleteRunDialogOpen = false">{{ t("common.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteRun">{{ t("databaseBackup.delete") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="renameRunDialogOpen">
    <DialogContent class="max-w-md">
      <DialogHeader
        ><DialogTitle>{{ t("databaseBackup.renameBackup") }}</DialogTitle></DialogHeader
      >
      <div class="space-y-2">
        <Label>{{ t("databaseBackup.backupName") }}</Label>
        <Input v-model="renameRunName" autofocus @keyup.enter="confirmRenameRun" />
      </div>
      <DialogFooter>
        <Button variant="outline" @click="renameRunDialogOpen = false">{{ t("common.cancel") }}</Button>
        <Button :disabled="!renameRunName.trim()" @click="confirmRenameRun">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
