<script setup lang="ts">
// Scheduler / Task Center page (plan §46–50). Self-contained: loads tasks,
// runs and resident sessions through the scheduler API, keeps them fresh from
// `dbx-scheduler-event` notifications, and hosts the task editor dialog. The
// page owns no timers-as-scheduler and no task lifecycle — the background
// worker does.
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarClock, History, Server } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import * as schedulerApi from "@/lib/scheduler/schedulerApi";
import { subscribeSchedulerEvents } from "@/lib/scheduler/schedulerEvents";
import { builtinTaskProviders, discoverTaskProviders } from "@/lib/scheduler/schedulerProviders";
import { isActiveRunStatus } from "@/lib/scheduler/schedulerDraft";
import type { InstalledPlugin } from "@/types/database";
import type { ResidentSession, SchedulerTaskProviderDescriptor, TaskDefinition, TaskRun } from "@/lib/scheduler/schedulerTypes";
import SchedulerResidentList from "./SchedulerResidentList.vue";
import SchedulerRunDetail from "./SchedulerRunDetail.vue";
import SchedulerRunList from "./SchedulerRunList.vue";
import SchedulerTaskEditor from "./SchedulerTaskEditor.vue";
import SchedulerTaskList from "./SchedulerTaskList.vue";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const activeTab = ref<string>("tasks");

const tasks = ref<TaskDefinition[]>([]);
const runs = ref<TaskRun[]>([]);
const residents = ref<ResidentSession[]>([]);
const plugins = ref<InstalledPlugin[]>([]);
const loading = ref(false);
const loadError = ref("");
const taskSearch = ref("");

const cancellingRunIds = reactive(new Set<string>());
const busyTaskIds = reactive(new Set<string>());

const editorOpen = ref(false);
const editingTask = ref<TaskDefinition | null>(null);
const pendingDelete = ref<TaskDefinition | null>(null);
const selectedRunId = ref("");

const providers = computed<SchedulerTaskProviderDescriptor[]>(() => [...builtinTaskProviders({ databaseBackup: t("scheduler.taskProviders.databaseBackup"), cloudSync: t("scheduler.taskProviders.cloudSync") }), ...discoverTaskProviders(plugins.value)]);

const connections = computed(() => connectionStore.connections);

const connectionNames = computed(() => new Map(connections.value.map((connection) => [connection.id, connection.name])));

const healthContext = computed(() => ({
  providers: providers.value,
  connectionIds: new Set(connections.value.map((connection) => connection.id)),
}));

const tasksById = computed(() => new Map(tasks.value.map((task) => [task.id, task])));

/** task id → run id for in-flight runs, so list cancel buttons have a target. */
const activeRunIds = computed(() => {
  const map = new Map<string, string>();
  for (const run of runs.value) {
    if (isActiveRunStatus(run.status)) map.set(run.taskId, run.id);
  }
  return map;
});

const activeRunCount = computed(() => runs.value.filter((run) => isActiveRunStatus(run.status)).length);

const runTaskFilter = ref("");
const runStatusFilter = ref("");

const filteredRuns = computed(() => runs.value.filter((run) => (!runTaskFilter.value || run.taskId === runTaskFilter.value) && (!runStatusFilter.value || run.status === runStatusFilter.value)));

let unlisten: (() => void) | undefined;

async function refreshTasks() {
  try {
    tasks.value = await schedulerApi.listTasks();
    loadError.value = "";
  } catch (reason) {
    loadError.value = reason instanceof Error ? reason.message : String(reason);
  }
}

async function refreshRuns() {
  try {
    runs.value = await schedulerApi.listRuns({ limit: 100 });
  } catch (reason) {
    // Run history failures should not blank the task list.
    console.warn("[scheduler] listRuns failed", reason);
  }
}

async function refreshResidents() {
  try {
    residents.value = await schedulerApi.listResidentSessions();
  } catch (reason) {
    console.warn("[scheduler] resident list failed", reason);
  }
}

async function refreshAll() {
  loading.value = true;
  await Promise.all([refreshTasks(), refreshRuns(), refreshResidents()]);
  loading.value = false;
}

onMounted(async () => {
  try {
    plugins.value = await import("@/lib/backend/api").then((module) => module.listPlugins());
  } catch (reason) {
    console.warn("[scheduler] plugin discovery failed", reason);
  }
  await refreshAll();
  unlisten = await subscribeSchedulerEvents((event) => {
    // Notifications are hints; state is rebuilt from the API.
    if (event.type === "task-changed") void refreshTasks();
    else if (event.type === "run-created" || event.type === "run-state" || event.type === "run-progress") {
      void refreshRuns();
      void refreshTasks();
    } else if (event.type === "resident-state") void refreshResidents();
  });
});

onUnmounted(() => {
  unlisten?.();
  unlisten = undefined;
});

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

async function withTaskBusy(taskId: string, action: () => Promise<void>) {
  if (busyTaskIds.has(taskId)) return;
  busyTaskIds.add(taskId);
  try {
    await action();
  } catch (reason) {
    toast(String(reason), 5000);
  } finally {
    busyTaskIds.delete(taskId);
  }
}

function openCreate() {
  editingTask.value = null;
  editorOpen.value = true;
}

function openEdit(task: TaskDefinition) {
  editingTask.value = task;
  editorOpen.value = true;
}

function onSaved(_task: TaskDefinition) {
  void refreshTasks();
}

async function toggleEnabled(task: TaskDefinition, enabled: boolean) {
  await withTaskBusy(task.id, async () => {
    if (enabled) await schedulerApi.enableTask(task.id);
    else await schedulerApi.disableTask(task.id);
    await refreshTasks();
  });
}

async function runNow(task: TaskDefinition) {
  await withTaskBusy(task.id, async () => {
    await schedulerApi.runTask(task.id);
    await refreshRuns();
    await refreshTasks();
  });
}

async function cancelRun(taskId: string, runId: string) {
  if (cancellingRunIds.has(runId)) return;
  cancellingRunIds.add(runId);
  try {
    await schedulerApi.cancelRun(taskId, runId);
    await refreshRuns();
    await refreshTasks();
  } catch (reason) {
    toast(String(reason), 5000);
  } finally {
    cancellingRunIds.delete(runId);
  }
}

function requestDelete(task: TaskDefinition) {
  pendingDelete.value = task;
}

async function confirmDelete() {
  const task = pendingDelete.value;
  if (!task) return;
  await withTaskBusy(task.id, async () => {
    await schedulerApi.deleteTask(task.id);
    pendingDelete.value = null;
    await refreshTasks();
    await refreshRuns();
  });
}

function viewRuns(task: TaskDefinition) {
  runTaskFilter.value = task.id;
  runStatusFilter.value = "";
  selectedRunId.value = "";
  activeTab.value = "runs";
}

// ---------------------------------------------------------------------------
// Resident actions
// ---------------------------------------------------------------------------

const residentBusy = ref(false);

async function residentAction(session: ResidentSession, action: "start" | "stop" | "restart") {
  residentBusy.value = true;
  try {
    await schedulerApi.residentAction(session.sessionId || session.id, action);
    await refreshResidents();
  } catch (reason) {
    toast(String(reason), 5000);
  } finally {
    residentBusy.value = false;
  }
}

function onRunCancel(run: TaskRun) {
  void cancelRun(run.taskId, run.id);
}
</script>

<template>
  <div class="relative mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-hidden px-6 py-6" data-scheduler-page>
    <div v-if="loadError" class="flex shrink-0 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" data-scheduler-load-error>
      <span class="min-w-0 flex-1 break-words">{{ t("scheduler.loadFailed", { error: loadError }) }}</span>
      <Button variant="outline" size="sm" class="h-7 shrink-0 text-xs" :disabled="loading" data-scheduler-retry @click="() => void refreshAll()">{{ t("scheduler.retry") }}</Button>
    </div>

    <Tabs v-model="activeTab" class="min-h-0 flex-1 gap-3">
      <TabsList class="grid h-9 w-full grid-cols-3">
        <TabsTrigger value="tasks" class="gap-1.5 text-xs" data-scheduler-tab-tasks>
          <CalendarClock class="size-3.5" />
          {{ t("scheduler.tabs.tasks") }}
          <span v-if="tasks.length" class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground">{{ tasks.length > 99 ? "99+" : tasks.length }}</span>
        </TabsTrigger>
        <TabsTrigger value="runs" class="gap-1.5 text-xs" data-scheduler-tab-runs>
          <History class="size-3.5" />
          {{ t("scheduler.tabs.runs") }}
          <span v-if="activeRunCount" class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground" data-scheduler-active-run-count>{{ activeRunCount > 99 ? "99+" : activeRunCount }}</span>
        </TabsTrigger>
        <TabsTrigger value="resident" class="gap-1.5 text-xs" data-scheduler-tab-resident>
          <Server class="size-3.5" />
          {{ t("scheduler.tabs.resident") }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="tasks" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <SchedulerTaskList
          v-model:search="taskSearch"
          :tasks="tasks"
          :health-context="healthContext"
          :connection-names="connectionNames"
          :active-run-ids="activeRunIds"
          :cancelling-run-ids="cancellingRunIds"
          :busy="loading"
          @create="openCreate"
          @edit="openEdit"
          @toggle-enabled="(task, enabled) => void toggleEnabled(task, enabled)"
          @run-now="(task) => void runNow(task)"
          @cancel="(task, runId) => void cancelRun(task.id, runId)"
          @delete="requestDelete"
          @view-runs="viewRuns"
          @reload="() => void refreshAll()"
        />
      </TabsContent>

      <TabsContent value="runs" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <SchedulerRunDetail v-if="selectedRunId" :run-id="selectedRunId" @back="selectedRunId = ''" @cancel="onRunCancel" />
        <SchedulerRunList v-else v-model:task-filter="runTaskFilter" v-model:status-filter="runStatusFilter" :runs="filteredRuns" :tasks="tasks" :loading="loading" @select="(run) => (selectedRunId = run.id)" @reload="() => void refreshRuns()" />
      </TabsContent>

      <TabsContent value="resident" class="m-0 min-h-0 flex-1 overflow-y-auto">
        <SchedulerResidentList :sessions="residents" :tasks="[...tasksById.values()]" :busy="residentBusy" @action="(session, action) => void residentAction(session, action)" />
      </TabsContent>
    </Tabs>

    <SchedulerTaskEditor v-model:open="editorOpen" :task="editingTask" :providers="providers" :connections="connections" @saved="onSaved" />

    <Dialog :open="!!pendingDelete" @update:open="(value: boolean) => !value && (pendingDelete = null)">
      <DialogContent class="max-w-md">
        <DialogHeader
          ><DialogTitle>{{ pendingDelete?.name }}</DialogTitle></DialogHeader
        >
        <p class="text-sm text-muted-foreground">{{ pendingDelete ? t("scheduler.actions.deleteConfirm", { name: pendingDelete.name }) : "" }}</p>
        <DialogFooter>
          <Button variant="outline" @click="pendingDelete = null">{{ t("scheduler.editor.cancel") }}</Button>
          <Button variant="destructive" :disabled="!pendingDelete || busyTaskIds.has(pendingDelete.id)" data-scheduler-delete-confirm @click="() => void confirmDelete()">{{ t("scheduler.actions.delete") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
