<script setup lang="ts">
// Task list rows: name / provider / trigger / enabled / nextRunAt /
// lastRunStatus / health, with run-now, cancel, edit, delete and run-history
// actions (plan §46–50). Purely presentational — the page owns the API calls.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CalendarClock, ListMusic, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2 } from "@lucide/vue";
import { defaultTimeZone, findProvider, taskHealth, triggerSummary, type TaskHealthContext } from "@/lib/scheduler/schedulerProviders";
import type { TaskDefinition } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  tasks: readonly TaskDefinition[];
  healthContext: TaskHealthContext;
  connectionNames: ReadonlyMap<string, string>;
  /** task id → run id of the run a cancel button should target. */
  activeRunIds?: ReadonlyMap<string, string>;
  /** Run ids with a cancel request in flight. */
  cancellingRunIds?: ReadonlySet<string>;
  busy?: boolean;
}>();

const emit = defineEmits<{
  create: [];
  edit: [task: TaskDefinition];
  "toggle-enabled": [task: TaskDefinition, enabled: boolean];
  "run-now": [task: TaskDefinition];
  cancel: [task: TaskDefinition, runId: string];
  delete: [task: TaskDefinition];
  "view-runs": [task: TaskDefinition];
  reload: [];
}>();

const { t, locale } = useI18n();

const search = defineModel<string>("search", { default: "" });

const filteredTasks = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return props.tasks;
  return props.tasks.filter((task) => task.name.toLocaleLowerCase().includes(query) || task.providerId.toLocaleLowerCase().includes(query));
});

function activeRunId(task: TaskDefinition): string | undefined {
  return props.activeRunIds?.get(task.id);
}

function providerLabel(task: TaskDefinition): string {
  return findProvider(props.healthContext.providers, task.providerId)?.label ?? task.providerId;
}

function connectionLabel(task: TaskDefinition): string {
  const id = task.target?.connectionId;
  if (!id) return t("scheduler.editor.connectionAny");
  return props.connectionNames.get(id) ?? id;
}

function healthOf(task: TaskDefinition) {
  return taskHealth(task, props.healthContext);
}

function healthVariant(health: ReturnType<typeof healthOf>): "default" | "secondary" | "destructive" | "outline" {
  if (health === "healthy") return "default";
  if (health === "warning") return "secondary";
  if (health === "invalid" || health === "unavailable") return "destructive";
  return "outline";
}

function healthHint(task: TaskDefinition): string {
  const health = healthOf(task);
  if (health === "unavailable") return t("scheduler.health.unavailableHint");
  if (health === "invalid") return t("scheduler.health.invalidHint");
  if (health === "warning") return t("scheduler.health.warningHint");
  return `${providerLabel(task)} · ${connectionLabel(task)}`;
}

function formatDateTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("scheduler.time.never");
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function timeZoneSuffix(task: TaskDefinition): string {
  const trigger = task.trigger;
  if (trigger.type === "cron" || trigger.type === "once") return trigger.timeZone || defaultTimeZone();
  return "";
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input v-model="search" class="h-8 w-64 pl-8 text-xs" :placeholder="t('scheduler.taskList.columns.name')" data-scheduler-task-search />
      </div>
      <div class="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" class="size-8" :disabled="busy" :title="t('scheduler.refresh')" :aria-label="t('scheduler.refresh')" data-scheduler-refresh @click="emit('reload')">
          <RefreshCw class="size-3.5" :class="busy && 'animate-spin'" />
        </Button>
        <Button size="sm" data-scheduler-new-task :disabled="busy" @click="emit('create')">
          <Plus class="mr-1.5 size-3.5" />
          {{ t("scheduler.taskList.newTask") }}
        </Button>
      </div>
    </div>

    <div class="overflow-hidden rounded-md border border-border/70">
      <div v-if="filteredTasks.length === 0" class="flex min-h-44 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground">
        <CalendarClock class="h-8 w-8 opacity-60" />
        <div>
          <div class="text-sm font-medium text-foreground">{{ t("scheduler.taskList.empty") }}</div>
          <p class="mt-1 text-sm">{{ t("scheduler.taskList.emptyHint") }}</p>
        </div>
      </div>
      <div v-for="task in filteredTasks" :key="task.id" class="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" :data-scheduler-task-row="task.id">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate text-sm font-medium">{{ task.name }}</span>
            <Badge variant="outline" class="font-normal">{{ providerLabel(task) }}</Badge>
            <Badge :variant="healthVariant(healthOf(task))" class="font-normal">{{ t(`scheduler.health.${healthOf(task)}`) }}</Badge>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{{ triggerSummary(task.trigger) }}</span>
            <span v-if="timeZoneSuffix(task)">{{ timeZoneSuffix(task) }}</span>
            <span>{{ connectionLabel(task) }}</span>
            <span>{{ t("scheduler.taskList.columns.nextRun") }}: {{ formatDateTime(task.nextRunAt) }}</span>
            <span>{{ t("scheduler.taskList.columns.lastRun") }}: {{ task.lastRunStatus ? t(`scheduler.runs.status.${task.lastRunStatus}`) : t("scheduler.taskList.noRunsYet") }}</span>
          </div>
          <p v-if="healthOf(task) !== 'healthy'" class="mt-1 text-xs text-amber-600 dark:text-amber-400">{{ healthHint(task) }}</p>
        </div>
        <div class="flex items-center justify-end gap-1">
          <Switch :model-value="task.enabled" :disabled="busy || healthOf(task) === 'invalid'" :title="task.enabled ? t('scheduler.actions.disable') : t('scheduler.actions.enable')" @update:model-value="(value: boolean) => emit('toggle-enabled', task, value)" />
          <Button
            v-if="activeRunId(task)"
            variant="ghost"
            size="icon"
            class="h-8 w-8"
            :disabled="cancellingRunIds?.has(activeRunId(task)!)"
            :title="cancellingRunIds?.has(activeRunId(task)!) ? t('scheduler.actions.cancelling') : t('scheduler.actions.cancel')"
            @click="emit('cancel', task, activeRunId(task)!)"
            data-scheduler-task-cancel
          >
            <Square class="h-4 w-4" />
          </Button>
          <Button v-else variant="ghost" size="icon" class="h-8 w-8" :disabled="busy || healthOf(task) === 'unavailable'" :title="t('scheduler.actions.runNow')" @click="emit('run-now', task)" data-scheduler-task-run>
            <Play class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" :title="t('scheduler.actions.viewRuns')" @click="emit('view-runs', task)" data-scheduler-task-runs>
            <ListMusic class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="busy" :title="t('scheduler.actions.edit')" @click="emit('edit', task)" data-scheduler-task-edit>
            <Pencil class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-destructive" :disabled="busy" :title="t('scheduler.actions.delete')" @click="emit('delete', task)" data-scheduler-task-delete>
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
