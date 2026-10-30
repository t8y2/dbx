<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeftRight, ChevronRight } from "@lucide/vue";
import type { TaskRun } from "@/lib/backend/tauri";
import { formatTaskEndpoint, formatTaskTimestamp, taskRunElapsedMs } from "@/lib/taskHistory";
import { formatQueryDuration } from "@/lib/format/duration";

const props = defineProps<{ run: TaskRun }>();
const emit = defineEmits<{ open: [runId: string] }>();
const { t, locale } = useI18n();

const statusKey = computed(() => `taskHistory.status.${props.run.status}`);
const statusColor = computed(() => {
  switch (props.run.status) {
    case "succeeded":
      return "bg-green-500/10 text-green-700 dark:text-green-400";
    case "partial_failed":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "cancelled":
      return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";
    default:
      return "bg-primary/10 text-primary";
  }
});
const elapsedMs = computed(() => taskRunElapsedMs(props.run.startedAt, props.run.finishedAt));
</script>

<template>
  <button type="button" class="block w-full border-b px-3 py-3 text-left last:border-b-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="emit('open', run.runId)">
    <div class="flex min-w-0 items-start gap-2">
      <ArrowLeftRight class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-xs font-medium">{{ t("taskHistory.taskType.transfer") }}</span>
          <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" :class="statusColor">{{ t(statusKey) }}</span>
        </div>
        <div class="mt-1 truncate text-[11px] text-muted-foreground" :title="formatTaskEndpoint(run.source)">{{ t("taskHistory.sourceShort") }}: {{ formatTaskEndpoint(run.source) }}</div>
        <div class="truncate text-[11px] text-muted-foreground" :title="formatTaskEndpoint(run.target)">{{ t("taskHistory.targetShort") }}: {{ formatTaskEndpoint(run.target) }}</div>
        <div class="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[10px] text-muted-foreground">
          <time :datetime="run.startedAt">{{ formatTaskTimestamp(run.startedAt, locale) }}</time>
          <span v-if="elapsedMs !== null">{{ t("taskHistory.elapsed", { duration: formatQueryDuration(elapsedMs) }) }}</span>
          <span v-else>{{ t(run.status === "running" ? "taskHistory.running" : "taskHistory.durationUnavailable") }}</span>
        </div>
      </div>
      <ChevronRight class="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  </button>
</template>
