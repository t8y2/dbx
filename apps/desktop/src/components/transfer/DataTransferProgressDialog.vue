<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, ArrowRightLeft, CheckCircle2, Loader2, Minimize2, X, XCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDataTransferDuration, useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { translateBackendError } from "@/i18n/backend-errors";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ task: ExportTask }>();
const { cancelTask } = useExportTracker();
const currentTime = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const isActive = computed(() => ["Running", "Writing", "Cancelling"].includes(props.task.status));
const progressPercent = computed(() => {
  if (props.task.status === "Done") return 100;
  if (!props.task.totalTables) return 0;
  return Math.min(95, Math.round(((props.task.tableIndex ?? 0) / props.task.totalTables) * 100));
});
const elapsed = computed(() => {
  const startedAt = props.task.startedAt ?? currentTime.value;
  return formatDataTransferDuration((props.task.finishedAt ?? currentTime.value) - startedAt);
});
const statusText = computed(() => {
  if (props.task.status === "Cancelling") return t("databaseBackup.cancelling");
  if (props.task.status === "Done") return t("exportProgress.compareDone");
  if (props.task.status === "Error") return t("exportProgress.compareError");
  if (props.task.status === "Cancelled") return t("exportProgress.compareCancelled");
  return t("exportProgress.compareRunning");
});

onMounted(() => {
  elapsedTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});
</script>

<template>
  <Dialog :open="open" @update:open="open = $event">
    <DialogContent class="sm:max-w-lg" data-transfer-progress-dialog @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="h-4 w-4" />
          {{ t("exportProgress.dataTransferTitle", { name: task.tableName }) }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-4 py-3">
        <div class="flex items-center gap-2 text-sm">
          <Loader2 v-if="isActive" class="h-4 w-4 animate-spin text-primary" />
          <CheckCircle2 v-else-if="task.status === 'Done'" class="h-4 w-4 text-green-500" />
          <XCircle v-else-if="task.status === 'Error'" class="h-4 w-4 text-destructive" />
          <AlertCircle v-else class="h-4 w-4 text-yellow-500" />
          <span>{{ statusText }}</span>
        </div>

        <div class="space-y-1.5">
          <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div v-if="task.totalTables" class="h-full rounded-full transition-[width] duration-300" :class="task.status === 'Done' ? 'bg-green-500' : 'bg-primary'" :style="{ width: `${progressPercent}%` }" />
            <div v-else-if="isActive" class="export-progress-indeterminate h-full rounded-full bg-primary" />
          </div>
          <div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span class="truncate">{{ task.currentTable || task.tableName }}</span>
            <span class="shrink-0 tabular-nums">{{ task.tableIndex ?? 0 }} / {{ task.totalTables ?? 0 }} · {{ task.rowsExported.toLocaleString() }} {{ t("exportProgress.rowsShort") }}</span>
          </div>
          <div class="text-xs text-muted-foreground">{{ t("exportProgress.elapsed", { duration: elapsed }) }}</div>
        </div>

        <div v-if="task.errorMessage" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ translateBackendError(t, task.errorMessage) }}
        </div>
      </div>

      <DialogFooter>
        <template v-if="isActive">
          <Button variant="ghost" size="sm" @click="open = false">
            <Minimize2 class="mr-1 h-3.5 w-3.5" />
            {{ t("exportProgress.minimize") }}
          </Button>
          <Button variant="outline" size="sm" :disabled="task.status === 'Cancelling'" @click="cancelTask(task.exportId)">
            <Loader2 v-if="task.status === 'Cancelling'" class="mr-1 h-3.5 w-3.5 animate-spin" />
            <X v-else class="mr-1 h-3.5 w-3.5" />
            {{ task.status === "Cancelling" ? t("databaseBackup.cancelling") : t("exportProgress.cancel") }}
          </Button>
        </template>
        <Button v-else variant="outline" size="sm" @click="open = false">{{ t("exportProgress.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
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
