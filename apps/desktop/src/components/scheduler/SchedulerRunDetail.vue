<script setup lang="ts">
// Run detail: status / trigger / attempt / started / completed / duration /
// exit code / error / progress / artifacts, with the live log viewer attached.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, Loader2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRun, listArtifacts } from "@/lib/scheduler/schedulerApi";
import { runDuration, runStatusBadgeVariant } from "@/lib/scheduler/schedulerDraft";
import { subscribeSchedulerEvents } from "@/lib/scheduler/schedulerEvents";
import type { TaskArtifact, TaskRun } from "@/lib/scheduler/schedulerTypes";
import SchedulerLogViewer from "./SchedulerLogViewer.vue";

const props = defineProps<{
  runId: string;
}>();

const emit = defineEmits<{
  back: [];
  cancel: [run: TaskRun];
}>();

const { t, locale } = useI18n();

const run = ref<TaskRun | null>(null);
const artifacts = ref<TaskArtifact[]>([]);
const loading = ref(false);
const error = ref("");

let unlisten: (() => void) | undefined;

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [current, runArtifacts] = await Promise.all([getRun(props.runId), listArtifacts(props.runId).catch(() => [])]);
    if (props.runId !== requestId) return;
    run.value = current;
    artifacts.value = runArtifacts;
  } catch (reason) {
    if (props.runId === requestId) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (props.runId === requestId) loading.value = false;
  }
}

let requestId = "";

watch(
  () => props.runId,
  async (runId) => {
    requestId = runId;
    run.value = null;
    artifacts.value = [];
    await refresh();
  },
  { immediate: true },
);

onMounted(async () => {
  unlisten = await subscribeSchedulerEvents((event) => {
    if (event.runId !== props.runId) return;
    if (event.type === "run-state" || event.type === "run-created" || event.type === "run-progress") void refresh();
  });
});

onUnmounted(() => {
  unlisten?.();
  unlisten = undefined;
});

const isActive = computed(() => run.value?.status === "queued" || run.value?.status === "starting" || run.value?.status === "running");

function formatDateTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("scheduler.time.notAvailable");
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatSize(size?: number | null): string {
  if (size === undefined || size === null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
</script>

<template>
  <div class="flex flex-col gap-4" data-scheduler-run-detail>
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('scheduler.runs.backToList')" @click="emit('back')" data-scheduler-run-back>
          <ArrowLeft class="h-4 w-4" />
        </Button>
        <span class="truncate font-mono text-xs text-muted-foreground">{{ runId }}</span>
      </div>
      <Button v-if="run && isActive" variant="outline" size="sm" data-scheduler-run-cancel @click="run && emit('cancel', run)">
        <Loader2 class="mr-2 h-3.5 w-3.5" />
        {{ t("scheduler.actions.cancel") }}
      </Button>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

    <template v-if="run">
      <div class="grid gap-3 rounded-md border border-border/70 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div class="flex items-center gap-2">
          <Badge :variant="runStatusBadgeVariant(run.status)" data-scheduler-run-status>{{ t(`scheduler.runs.status.${run.status}`) }}</Badge>
          <Badge variant="outline" class="font-normal">{{ t(`scheduler.runs.trigger.${run.trigger}`) }}</Badge>
          <span v-if="run.attempt > 1" class="text-xs text-muted-foreground">#{{ run.attempt }}</span>
        </div>
        <div class="text-xs text-muted-foreground">
          <div>{{ t("scheduler.runs.columns.started") }}: {{ formatDateTime(run.startedAt || run.createdAt) }}</div>
          <div v-if="run.completedAt">{{ t("scheduler.runs.completedAt") }}: {{ formatDateTime(run.completedAt) }}</div>
        </div>
        <div class="text-xs text-muted-foreground">
          <div>{{ t("scheduler.runs.columns.duration") }}: {{ runDuration(run.startedAt, run.completedAt) || t("scheduler.time.notAvailable") }}</div>
          <div v-if="run.exitCode !== undefined && run.exitCode !== null">{{ t("scheduler.runs.exitCode", { code: run.exitCode }) }}</div>
        </div>
        <div v-if="run.progressPercent !== undefined && run.progressPercent !== null && isActive" class="sm:col-span-2 lg:col-span-3">
          <div class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>{{ t("scheduler.runs.progress") }}</span>
            <span class="tabular-nums">{{ Math.round(run.progressPercent) }}%</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(run.progressPercent)">
            <div class="h-full rounded-full bg-primary transition-[width] duration-300" :style="{ width: `${Math.min(100, Math.max(0, run.progressPercent))}%` }" />
          </div>
        </div>
        <p v-if="run.errorMessage" class="text-xs text-destructive sm:col-span-2 lg:col-span-3" data-scheduler-run-error>
          <span v-if="run.errorCode" class="font-mono">{{ run.errorCode }}: </span>{{ run.errorMessage }}
        </p>
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-semibold">{{ t("scheduler.runs.artifacts") }}</h4>
        <div v-if="artifacts.length === 0" class="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground" data-scheduler-run-artifacts-empty>{{ t("scheduler.runs.artifactsEmpty") }}</div>
        <div v-else class="overflow-hidden rounded-md border border-border/70">
          <div v-for="artifact in artifacts" :key="artifact.uri" class="grid gap-1 border-b border-border/70 px-3 py-2 text-xs last:border-b-0" :data-scheduler-run-artifact="artifact.name">
            <span class="font-medium">{{ artifact.name }}</span>
            <span class="break-all text-muted-foreground"
              >{{ artifact.uri }}<template v-if="formatSize(artifact.size)"> · {{ formatSize(artifact.size) }}</template></span
            >
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-semibold">{{ t("scheduler.log.title") }}</h4>
        <SchedulerLogViewer :run-id="runId" :run-status="run.status" />
      </div>
    </template>
    <div v-else-if="loading" class="flex items-center justify-center py-10 text-muted-foreground">
      <Loader2 class="h-5 w-5 animate-spin" />
    </div>
  </div>
</template>
