<script setup lang="ts">
// Run history list (plan §46–50): task / status / trigger / attempt / started /
// duration, with a status filter and a click-through to the run detail.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { runDuration, runStatusBadgeVariant } from "@/lib/scheduler/schedulerDraft";
import type { TaskDefinition, TaskRun, TaskRunStatus } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  runs: readonly TaskRun[];
  tasks: readonly TaskDefinition[];
  /** Undefined = no filter applied yet (server-side task filter is the page's job). */
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [run: TaskRun];
  "update:taskFilter": [taskId: string];
  "update:statusFilter": [status: string];
  reload: [];
}>();

const { t, locale } = useI18n();

const taskFilter = defineModel<string>("taskFilter", { default: "" });
const statusFilter = defineModel<string>("statusFilter", { default: "" });

const statusOptions: readonly TaskRunStatus[] = ["queued", "starting", "running", "success", "failed", "cancelled", "timeout", "skipped"];

const taskNameById = computed(() => new Map(props.tasks.map((task) => [task.id, task.name])));

function taskName(run: TaskRun): string {
  return taskNameById.value.get(run.taskId) || run.taskId;
}

function formatDateTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("scheduler.time.notAvailable");
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function activeRun(run: TaskRun): boolean {
  return run.status === "queued" || run.status === "starting" || run.status === "running";
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <Select v-model="taskFilter">
        <SelectTrigger class="w-52" :aria-label="t('scheduler.runs.filterAll')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">{{ t("scheduler.runs.filterAll") }}</SelectItem>
          <SelectItem v-for="task in tasks" :key="task.id" :value="task.id">{{ task.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="statusFilter">
        <SelectTrigger class="w-40" :aria-label="t('scheduler.runs.filterStatus')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">{{ t("scheduler.runs.filterStatus") }}</SelectItem>
          <SelectItem v-for="status in statusOptions" :key="status" :value="status">{{ t(`scheduler.runs.status.${status}`) }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" class="ml-auto" :disabled="loading" data-scheduler-runs-reload @click="emit('reload')">{{ t("scheduler.refresh") }}</Button>
    </div>

    <div class="overflow-hidden rounded-md border border-border/70">
      <div v-if="runs.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground" data-scheduler-runs-empty>
        {{ taskFilter || statusFilter ? t("scheduler.runs.emptyFiltered") : t("scheduler.runs.empty") }}
      </div>
      <button v-for="run in runs" :key="run.id" type="button" class="grid w-full gap-2 border-b border-border/70 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40" :data-scheduler-run-row="run.id" @click="emit('select', run)">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="truncate text-sm font-medium">{{ taskName(run) }}</span>
          <Badge :variant="runStatusBadgeVariant(run.status)" class="font-normal">{{ t(`scheduler.runs.status.${run.status}`) }}</Badge>
          <Badge variant="outline" class="font-normal">{{ t(`scheduler.runs.trigger.${run.trigger}`) }}</Badge>
          <span v-if="run.attempt > 1" class="text-xs text-muted-foreground">#{{ run.attempt }}</span>
          <span v-if="activeRun(run)" class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" data-scheduler-run-active="" />
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{{ t("scheduler.runs.columns.started") }}: {{ formatDateTime(run.startedAt || run.createdAt) }}</span>
          <span>{{ t("scheduler.runs.columns.duration") }}: {{ runDuration(run.startedAt, run.completedAt) || t("scheduler.time.notAvailable") }}</span>
          <span v-if="run.errorCode" class="text-destructive">{{ run.errorCode }}</span>
          <span v-else-if="run.errorMessage" class="max-w-md truncate text-destructive">{{ run.errorMessage }}</span>
        </div>
      </button>
    </div>
  </div>
</template>
