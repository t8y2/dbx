<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, AlertCircle, X, FileDown } from "@lucide/vue";
import { useExportTracker } from "@/composables/useExportTracker";

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

const progressPercent = (totalRows: number | null, rowsExported: number) => {
  if (!totalRows || totalRows <= 0) return 0;
  return Math.min(100, Math.round((rowsExported / totalRows) * 100));
};

const rowsText = (task: { totalRows: number | null; rowsExported: number }) => {
  if (task.totalRows) {
    return `${task.rowsExported.toLocaleString()} / ${task.totalRows.toLocaleString()}`;
  }
  return `${task.rowsExported.toLocaleString()} ${t("exportProgress.rowsShort")}`;
};

const statusIcon = (status: string) => {
  switch (status) {
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
      <Button variant="ghost" size="icon" class="relative h-8 w-8" :title="t('exportProgress.tooltip')" :class="{ 'bg-accent text-primary': hasActive }">
        <FileDown class="h-4 w-4" />
        <span v-if="hasActive" class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
          {{ activeCount > 9 ? "9+" : activeCount }}
        </span>
      </Button>
    </PopoverTrigger>

    <PopoverContent align="start" class="w-80 p-0 gap-0 overflow-hidden" :side-offset="8">
      <div class="border-b bg-muted/40 px-3 py-2">
        <div class="text-sm font-semibold">{{ t("exportProgress.popoverTitle") }}</div>
      </div>

      <div class="max-h-80 overflow-y-auto">
        <div v-for="task in visibleTasks" :key="task.exportId" class="flex items-center gap-2 border-b px-3 py-2.5 text-xs last:border-b-0">
          <div class="flex-1 min-w-0 flex flex-col gap-1">
            <div class="flex items-center gap-1.5">
              <component :is="statusIcon(task.status)" :class="[statusColor(task.status), isActive(task.status) ? 'animate-spin' : '']" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate font-medium">{{ task.tableName }}.{{ task.format }}</span>
            </div>

            <!-- Progress bar -->
            <div v-if="isActive(task.status)" class="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div class="h-full bg-primary rounded-full transition-[width] duration-300" :class="{ 'animate-pulse': !task.totalRows }" :style="{ width: task.totalRows ? `${progressPercent(task.totalRows, task.rowsExported)}%` : '50%' }" />
            </div>
            <div v-else-if="task.status === 'Done'" class="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div class="h-full bg-green-500 rounded-full" style="width: 100%" />
            </div>

            <div class="flex items-center justify-between text-muted-foreground">
              <span class="tabular-nums">{{ rowsText(task) }}</span>
              <span v-if="task.status === 'Error' && task.errorMessage" class="truncate ml-2 text-destructive" :title="task.errorMessage">
                {{ task.errorMessage }}
              </span>
            </div>
          </div>

          <!-- Actions: stop/cancel for active, delete for finished -->
          <div class="flex shrink-0 self-center">
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
