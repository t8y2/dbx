<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronRight, DatabaseBackup, FolderOpen, Loader2, Pencil, Play, Plus, RotateCcw, Square, Trash2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { useScheduledDatabaseBackups } from "@/composables/useScheduledDatabaseBackups";
import { useToast } from "@/composables/useToast";
import { generateDatabaseExportId } from "@/lib/export/databaseExport";
import { nextDatabaseBackupRunAt, normalizeDatabaseBackupTablePatterns, supportsScheduledDatabaseBackup, type DatabaseBackupFile, type DatabaseBackupRun, type DatabaseBackupSchedule } from "@/lib/backup/scheduledDatabaseBackup";
import { useConnectionStore } from "@/stores/connectionStore";

const { t, locale } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const { schedules, runs, activeScheduleIds, activeRunIds, activeRuns, saveSchedule, setScheduleEnabled, deleteSchedule, deleteRun, runSchedule, cancelRun } = useScheduledDatabaseBackups();

const scheduleDialogOpen = ref(false);
const deleteScheduleDialogOpen = ref(false);
const deleteRunDialogOpen = ref(false);
const editingScheduleId = ref("");
const pendingDeleteSchedule = ref<DatabaseBackupSchedule | null>(null);
const pendingDeleteRun = ref<DatabaseBackupRun | null>(null);
const loadingDatabases = ref(false);
const saving = ref(false);
const databaseOptions = ref<string[]>([]);
const allDatabases = ref(true);
const selectedDatabases = ref<string[]>([]);
const tablePatternsInput = ref("");
const expandedRunIds = reactive(new Set<string>());

const sqlConnections = computed(() => connectionStore.connections.filter((connection) => supportsScheduledDatabaseBackup(connection.db_type)));
const sortedRuns = computed(() => [...runs.value].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)));
const weekdays = computed(() => [
  { value: 0, label: t("databaseBackup.weekdays.sunday") },
  { value: 1, label: t("databaseBackup.weekdays.monday") },
  { value: 2, label: t("databaseBackup.weekdays.tuesday") },
  { value: 3, label: t("databaseBackup.weekdays.wednesday") },
  { value: 4, label: t("databaseBackup.weekdays.thursday") },
  { value: 5, label: t("databaseBackup.weekdays.friday") },
  { value: 6, label: t("databaseBackup.weekdays.saturday") },
]);

function newScheduleDraft(connectionId = sqlConnections.value[0]?.id ?? ""): DatabaseBackupSchedule {
  const now = new Date();
  const draft: DatabaseBackupSchedule = {
    id: generateDatabaseExportId(),
    name: t("databaseBackup.defaultScheduleName"),
    enabled: true,
    connectionId,
    databases: [],
    tableFilterMode: "all",
    tablePatterns: [],
    destinationDirectory: "",
    frequency: "daily",
    intervalHours: 6,
    timeOfDay: "02:00",
    weekday: 1,
    includeStructure: true,
    includeData: true,
    includeObjects: true,
    dropTableIfExists: false,
    retentionCount: 10,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: "",
  };
  draft.nextRunAt = nextDatabaseBackupRunAt(draft, now).toISOString();
  return draft;
}

const draft = ref<DatabaseBackupSchedule>(newScheduleDraft());
const canSave = computed(() => {
  const hasContent = draft.value.includeStructure || draft.value.includeData || draft.value.includeObjects;
  const hasDatabaseScope = allDatabases.value || selectedDatabases.value.length > 0;
  const hasTableScope = draft.value.tableFilterMode === "all" || normalizeDatabaseBackupTablePatterns(tablePatternsInput.value).length > 0;
  return !!draft.value.name.trim() && !!draft.value.connectionId && !!draft.value.destinationDirectory.trim() && hasContent && hasDatabaseScope && hasTableScope && !saving.value && !loadingDatabases.value;
});
const nextRunPreview = computed(() => nextDatabaseBackupRunAt(draft.value, new Date()));

function connectionName(connectionId: string): string {
  return connectionStore.getConfig(connectionId)?.name || t("databaseBackup.missingConnection");
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

function runStatusVariant(status: DatabaseBackupRun["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "success") return "default";
  if (status === "failed") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

function activeRunForSchedule(scheduleId: string): DatabaseBackupRun | undefined {
  return activeRuns.value.find((run) => run.scheduleId === scheduleId);
}

async function loadDatabases(connectionId: string, preserveSelection: boolean) {
  databaseOptions.value = [];
  if (!connectionId) return;
  loadingDatabases.value = true;
  try {
    await connectionStore.ensureConnected(connectionId);
    const names = (await api.listDatabases(connectionId)).map((database) => database.name);
    databaseOptions.value = names;
    if (!preserveSelection) {
      selectedDatabases.value = [];
      allDatabases.value = true;
      draft.value.tableFilterMode = "all";
      draft.value.tablePatterns = [];
      tablePatternsInput.value = "";
    }
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  } finally {
    loadingDatabases.value = false;
  }
}

async function openCreateSchedule() {
  editingScheduleId.value = "";
  draft.value = newScheduleDraft();
  allDatabases.value = true;
  selectedDatabases.value = [];
  tablePatternsInput.value = "";
  scheduleDialogOpen.value = true;
  await loadDatabases(draft.value.connectionId, false);
}

async function openEditSchedule(schedule: DatabaseBackupSchedule) {
  editingScheduleId.value = schedule.id;
  draft.value = { ...schedule, databases: [...schedule.databases], tablePatterns: [...schedule.tablePatterns] };
  allDatabases.value = schedule.databases.length === 0;
  selectedDatabases.value = [...schedule.databases];
  tablePatternsInput.value = schedule.tablePatterns.join(", ");
  scheduleDialogOpen.value = true;
  await loadDatabases(schedule.connectionId, true);
}

async function changeConnection(connectionId: string) {
  draft.value.connectionId = connectionId;
  await loadDatabases(connectionId, false);
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
  if (typeof selected === "string") draft.value.destinationDirectory = selected;
}

async function submitSchedule() {
  if (!canSave.value) return;
  saving.value = true;
  try {
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

async function runNow(schedule: DatabaseBackupSchedule) {
  try {
    const run = await runSchedule(schedule.id, "manual");
    if (!run) return;
    if (run.status === "success") toast(t("databaseBackup.runSuccess", { count: run.files.length }), 3000);
    else if (run.status === "cancelled") toast(t("databaseBackup.runCancelled"), 3000);
    else toast(t("databaseBackup.runFailed", { error: run.error || t("databaseBackup.unknownError") }), 5000);
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
    toast(error?.message || String(error), 5000);
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
      </div>
      <Button size="sm" :disabled="sqlConnections.length === 0" @click="openCreateSchedule">
        <Plus class="mr-2 h-4 w-4" />
        {{ t("databaseBackup.addSchedule") }}
      </Button>
    </div>

    <div class="overflow-hidden rounded-md border border-border/70">
      <div v-if="schedules.length === 0" class="flex min-h-36 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground">
        <DatabaseBackup class="h-8 w-8 opacity-60" />
        <span class="text-sm">{{ t("databaseBackup.noSchedules") }}</span>
      </div>
      <div v-for="schedule in schedules" :key="schedule.id" class="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate text-sm font-medium">{{ schedule.name }}</span>
            <Badge variant="outline" class="font-normal">{{ connectionName(schedule.connectionId) }}</Badge>
            <Badge v-if="activeScheduleIds.has(schedule.id)" variant="secondary" class="font-normal">{{ t("databaseBackup.status.running") }}</Badge>
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
          <Button v-if="activeRunForSchedule(schedule.id)" variant="ghost" size="icon" class="h-8 w-8" :title="t('databaseBackup.cancel')" @click="cancelRun(activeRunForSchedule(schedule.id)!.id)">
            <Square class="h-4 w-4" />
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
      <h3 class="text-base font-semibold">{{ t("databaseBackup.history") }}</h3>
      <div class="overflow-hidden rounded-md border border-border/70">
        <div v-if="sortedRuns.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ t("databaseBackup.noHistory") }}</div>
        <template v-for="run in sortedRuns" :key="run.id">
          <div class="grid gap-2 border-b border-border/70 px-3 py-3 last:border-b-0 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="run.files.length === 0" :title="t('databaseBackup.showFiles')" @click="toggleRunExpanded(run.id)">
              <ChevronDown v-if="expandedRunIds.has(run.id)" class="h-4 w-4" />
              <ChevronRight v-else class="h-4 w-4" />
            </Button>
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="truncate text-sm font-medium">{{ run.scheduleName }}</span>
                <Badge :variant="runStatusVariant(run.status)" class="font-normal">{{ runStatusLabel(run.status) }}</Badge>
                <Badge variant="outline" class="font-normal">{{ run.trigger === "scheduled" ? t("databaseBackup.scheduledTrigger") : t("databaseBackup.manualTrigger") }}</Badge>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{{ run.connectionName || connectionName(run.connectionId) }}</span>
                <span>{{ formatDate(run.startedAt) }}</span>
                <span>{{ t("databaseBackup.fileCount", { count: run.files.length }) }}</span>
                <span v-if="run.error" class="break-all text-destructive">{{ run.error }}</span>
              </div>
            </div>
            <div class="flex items-center justify-end gap-1">
              <Loader2 v-if="activeRunIds.has(run.id)" class="mr-2 h-4 w-4 animate-spin text-primary" />
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
    <DialogContent class="max-h-[min(760px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(720px,calc(100vw-32px))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ editingScheduleId ? t("databaseBackup.editSchedule") : t("databaseBackup.addSchedule") }}</DialogTitle>
      </DialogHeader>

      <div class="grid gap-5 py-1">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label>{{ t("databaseBackup.scheduleName") }}</Label>
            <Input v-model="draft.name" />
          </div>
          <div class="space-y-2">
            <Label>{{ t("databaseBackup.connection") }}</Label>
            <Select :model-value="draft.connectionId" @update:model-value="(value: any) => changeConnection(String(value))">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">{{ connection.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="space-y-2">
          <Label>{{ t("databaseBackup.destination") }}</Label>
          <div class="flex gap-2">
            <Input v-model="draft.destinationDirectory" readonly class="min-w-0" />
            <Button variant="outline" size="icon" class="shrink-0" :title="t('databaseBackup.selectDestination')" @click="chooseDestination">
              <FolderOpen class="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between gap-4">
            <Label>{{ t("databaseBackup.databases") }}</Label>
            <label class="flex items-center gap-2 text-sm">
              <input v-model="allDatabases" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" />
              {{ t("databaseBackup.allDatabases") }}
            </label>
          </div>
          <div v-if="!allDatabases" class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-2">
            <div v-if="loadingDatabases" class="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</div>
            <label v-for="database in databaseOptions" v-else :key="database" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
              <input type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :checked="selectedDatabases.includes(database)" @change="toggleDatabase(database)" />
              <span class="truncate">{{ database }}</span>
            </label>
          </div>
        </div>

        <div class="space-y-3">
          <div class="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
            <div class="space-y-2">
              <Label>{{ t("databaseBackup.tableScope") }}</Label>
              <Select v-model="draft.tableFilterMode">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ t("databaseBackup.allTables") }}</SelectItem>
                  <SelectItem value="include">{{ t("databaseBackup.includeTables") }}</SelectItem>
                  <SelectItem value="exclude">{{ t("databaseBackup.excludeTables") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div v-if="draft.tableFilterMode !== 'all'" class="space-y-2">
              <Label>{{ t("databaseBackup.tablePatterns") }}</Label>
              <Input v-model="tablePatternsInput" :placeholder="t('databaseBackup.tablePatternsPlaceholder')" />
            </div>
          </div>
          <p v-if="draft.tableFilterMode !== 'all'" class="text-xs text-muted-foreground">{{ t("databaseBackup.tablePatternsHint") }}</p>
        </div>

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

        <div class="space-y-3">
          <Label>{{ t("databaseBackup.contents") }}</Label>
          <div class="grid gap-2 sm:grid-cols-2">
            <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeStructure" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeStructure") }}</label>
            <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeData" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeData") }}</label>
            <label class="flex items-center gap-2 text-sm"><input v-model="draft.includeObjects" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.includeObjects") }}</label>
            <label class="flex items-center gap-2 text-sm"><input v-model="draft.dropTableIfExists" type="checkbox" class="h-4 w-4 accent-primary" />{{ t("databaseExport.dropTableIfExists") }}</label>
          </div>
        </div>

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
</template>
