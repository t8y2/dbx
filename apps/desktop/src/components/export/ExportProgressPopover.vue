<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, AlertCircle, X, FileDown, DatabaseBackup, FileCode2, ArrowRightLeft } from "@lucide/vue";
import { formatDataTransferDuration, useExportTracker, type ExportTask } from "@/composables/useExportTracker";

const { t } = useI18n();
const { tasks, activeCount, hasActive, clearFinished, cancelTask, removeTask } = useExportTracker();
const open = ref(false);
const showAll = ref(false);
const MAX_VISIBLE = 5;

const reversedTasks = computed(() => {
  return [...tasks.value].reverse();
});

const visibleTasks = computed(() => {
  return showAll.value ? reversedTasks.value : reversedTasks.value.slice(0, MAX_VISIBLE);
});

const hasMore = computed(() => tasks.value.length > MAX_VISIBLE);

const isActive = (status: string) => status === "Running" || status === "Writing";
const isFinished = (status: string) => status === "Done" || status === "Error" || status === "Cancelled";

const finishedCount = computed(() => tasks.value.filter((t) => isFinished(t.status)).length);
const failedCount = computed(() => tasks.value.filter((t) => t.status === "Error").length);
const triggerTitle = computed(() => (failedCount.value > 0 ? t("exportProgress.failedTooltip", { count: failedCount.value }) : t("exportProgress.tooltip")));

const progressPercent = (totalRows: number | null, rowsExported: number) => {
  if (!totalRows || totalRows <= 0) return 0;
  return Math.min(100, Math.round((rowsExported / totalRows) * 100));
};

const progressValue = (task: ExportTask) => {
  if (task.kind === "database-export") {
    if (!task.totalObjects || task.totalObjects <= 0) return 0;
    return Math.min(100, Math.round(((task.objectIndex ?? 0) / task.totalObjects) * 100));
  }
  if (task.kind === "sql-file") {
    const total = task.totalRows ?? task.statementIndex ?? 0;
    if (task.status === "Done") return 100;
    if (total <= 0) return 0;
    return Math.min(95, Math.round((task.rowsExported / total) * 100));
  }
  if (task.kind === "data-transfer") {
    if (!task.totalTables || task.totalTables <= 0) return 0;
    if (task.status === "Done") return 100;
    return Math.min(95, Math.round(((task.tableIndex ?? 0) / task.totalTables) * 100));
  }
  return progressPercent(task.totalRows, task.rowsExported);
};

const taskTitle = (task: ExportTask) => {
  if (task.kind === "database-export") return t("exportProgress.databaseExportTitle", { name: task.tableName });
  if (task.kind === "sql-file") return t("exportProgress.sqlFileTitle", { name: task.tableName });
  if (task.kind === "data-transfer") return t("exportProgress.dataTransferTitle", { name: task.tableName });
  return `${task.tableName}.${task.format}`;
};

const rowsText = (task: ExportTask) => {
  if (task.kind === "database-export") {
    if (task.totalObjects) {
      return t("exportProgress.objectsCount", {
        current: (task.objectIndex ?? 0).toLocaleString(),
        total: task.totalObjects.toLocaleString(),
      });
    }
    return t("exportProgress.rowsExported", { count: task.rowsExported.toLocaleString() });
  }
  if (task.kind === "sql-file") {
    return t("exportProgress.statementsCount", {
      done: (task.successCount ?? 0).toLocaleString(),
      failed: (task.failureCount ?? 0).toLocaleString(),
    });
  }
  if (task.kind === "data-transfer") {
    const tableText = task.totalTables
      ? t("exportProgress.tablesCount", {
          current: (task.tableIndex ?? 0).toLocaleString(),
          total: task.totalTables.toLocaleString(),
        })
      : task.currentTable || "";
    const rowText = task.totalRows ? `${task.rowsExported.toLocaleString()} / ${task.totalRows.toLocaleString()} ${t("exportProgress.rowsShort")}` : `${task.rowsExported.toLocaleString()} ${t("exportProgress.rowsShort")}`;
    const finishedAt = task.finishedAt ?? Date.now();
    const durationText = t("exportProgress.elapsed", { duration: formatDataTransferDuration(finishedAt - (task.startedAt ?? finishedAt)) });
    return task.currentTable ? `${tableText} · ${task.currentTable} · ${rowText} · ${durationText}` : `${tableText} · ${durationText}`;
  }
  if (task.totalRows) return `${task.rowsExported.toLocaleString()} / ${task.totalRows.toLocaleString()}`;
  return `${task.rowsExported.toLocaleString()} ${t("exportProgress.rowsShort")}`;
};

const statusIcon = (task: ExportTask) => {
  if (isActive(task.status)) {
    if (task.kind === "database-export") return DatabaseBackup;
    if (task.kind === "sql-file") return FileCode2;
    if (task.kind === "data-transfer") return ArrowRightLeft;
  }
  switch (task.status) {
    case "Running":
    case "Writing":
      return Loader2;
    case "Done":
      return CheckCircle2;
    case "Error":
      return XCircle;
    case "Cancelled":
      return AlertCircle;
    default:
      return Loader2;
  }
};

const statusColor = (status: string) => {
  switch (status) {
    case "Running":
    case "Writing":
      return "text-primary";
    case "Done":
      return "text-green-500";
    case "Error":
      return "text-destructive";
    case "Cancelled":
      return "text-yellow-500";
    default:
      return "text-muted-foreground";
  }
};

function toggleShowAll() {
  showAll.value = !showAll.value;
}
</script>

<template>
  <Popover v-if="tasks.length > 0" v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="icon" class="relative h-8 w-8" :title="triggerTitle" :class="{ 'bg-destructive/10 text-destructive hover:bg-destructive/15': failedCount > 0, 'bg-accent text-primary': failedCount === 0 && hasActive }">
        <FileDown class="h-4 w-4" />
        <span v-if="failedCount > 0" class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"> ! </span>
        <span v-else-if="hasActive" class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
          {{ activeCount > 9 ? "9+" : activeCount }}
        </span>
      </Button>
    </PopoverTrigger>

    <PopoverContent align="start" class="w-[min(92vw,30rem)] p-0 gap-0 overflow-hidden" :side-offset="8">
      <div class="border-b bg-muted/40 px-4 py-3">
        <div class="text-sm font-semibold">{{ t("exportProgress.popoverTitle") }}</div>
      </div>

      <div class="max-h-96 overflow-y-auto">
        <div v-for="task in visibleTasks" :key="task.exportId" class="flex items-start gap-3 border-b px-4 py-3 text-xs last:border-b-0">
          <div class="flex-1 min-w-0 flex flex-col gap-1.5">
            <div class="flex items-center gap-1.5">
              <component :is="statusIcon(task)" :class="[statusColor(task.status), task.kind === 'table-export' && isActive(task.status) ? 'animate-spin' : '']" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate font-medium">{{ taskTitle(task) }}</span>
            </div>

            <!-- Progress bar -->
            <div v-if="isActive(task.status)" class="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div v-if="task.totalRows || (task.kind === 'database-export' && task.totalObjects) || (task.kind === 'data-transfer' && task.totalTables)" class="h-full bg-primary rounded-full transition-[width] duration-300" :style="{ width: `${progressValue(task)}%` }" />
              <div v-else class="h-full w-full overflow-hidden rounded-full">
                <div class="export-progress-indeterminate h-full rounded-full bg-primary" />
              </div>
            </div>
            <div v-else-if="task.status === 'Done'" class="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div class="h-full bg-green-500 rounded-full" style="width: 100%" />
            </div>

            <div class="min-w-0 text-muted-foreground">
              <span class="break-words tabular-nums">{{ rowsText(task) }}</span>
              <span v-if="task.status === 'Error' && task.errorMessage" class="mt-1 block whitespace-normal break-words text-destructive" :title="task.errorMessage">
                {{ task.errorMessage }}
              </span>
            </div>
          </div>

          <!-- Actions: stop/cancel for active, delete for finished -->
          <div class="flex shrink-0 pt-4">
            <button v-if="isActive(task.status)" class="flex h-6 w-6 items-center justify-center rounded hover:bg-muted" :title="t('exportProgress.cancel')" @click="cancelTask(task.exportId)">
              <X class="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
            <button v-else class="flex h-6 w-6 items-center justify-center rounded hover:bg-muted" :title="t('exportProgress.delete')" @click="removeTask(task.exportId)">
              <X class="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="hasMore" class="border-t bg-muted/30 px-3 py-1.5">
        <button class="w-full text-center text-xs text-muted-foreground hover:text-foreground" @click="toggleShowAll">
          {{ showAll ? t("exportProgress.showLess") : t("exportProgress.showMore", { count: tasks.length - MAX_VISIBLE }) }}
        </button>
      </div>

      <div v-if="finishedCount > 0" class="border-t bg-muted/30 px-3 py-1.5">
        <button class="w-full text-center text-xs text-muted-foreground hover:text-foreground" @click="clearFinished">
          {{ t("exportProgress.clearFinished") }}
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.export-progress-indeterminate {
  width: 42%;
  animation: export-progress-slide 1.15s ease-in-out infinite;
}

@keyframes export-progress-slide {
  0% {
    transform: translateX(-110%);
  }
  50% {
    transform: translateX(70%);
  }
  100% {
    transform: translateX(250%);
  }
}
</style>
