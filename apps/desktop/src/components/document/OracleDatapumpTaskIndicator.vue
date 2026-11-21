<script setup lang="ts">
import { computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CheckCircle2, Loader2, Maximize2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useOracleDatapumpTask } from "@/composables/useOracleDatapumpTask";
import { useDialogSources } from "@/composables/useDialogSources";

// 常驻右下角的任务药丸（独立于对话框生命周期）：
// 对话框打开且非最小化时，隐藏"正在对话框里展示"的那个任务；
// 其余任务一律显示。药丸只能由用户手动关闭，任何情况都不自动消失。

const { t } = useI18n();
const dpTask = useOracleDatapumpTask();
const dialogs = useDialogSources();

const pills = computed(() => {
  const viewingActive = dpTask.dialogOpen.value && !dpTask.dialogMinimized.value;
  return dpTask.tasks.value.filter((task) => !(viewingActive && task.taskId === dpTask.activeTaskId.value));
});

// 空闲药丸：没开始任务就最小化 → 显示一个"继续配置"的药丸。
const showIdlePill = computed(() => dpTask.formMinimized.value && !dpTask.dialogOpen.value);

function restoreIdle() {
  dpTask.formMinimized.value = false;
  dialogs.showOracleDatapumpDialog.value = true;
}

function restore(taskId: string) {
  const task = dpTask.tasks.value.find((item) => item.taskId === taskId);
  if (!task) return;
  dialogs.oracleDatapumpPrefillConnectionId.value = task.connectionId;
  dialogs.oracleDatapumpPrefillDatabase.value = task.database;
  dialogs.oracleDatapumpMode.value = task.kind;
  // 对话框可能处于最小化态：必须取消最小化否则内容不显示。
  dpTask.dialogMinimized.value = false;
  dpTask.focusTask(taskId);
  dialogs.showOracleDatapumpDialog.value = true;
  // 对话框挂载时 resetConfigure 会覆盖 activeTaskId；nextTick 后再设一次。
  nextTick(() => {
    dpTask.focusTask(taskId);
  });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="pills.length > 0 || showIdlePill" class="fixed bottom-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div v-for="task in pills" :key="task.taskId" class="flex items-center gap-2 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-lg" :title="task.running ? t('oracleDatapump.backgroundWarning') : undefined">
        <Loader2 v-if="task.running" class="h-4 w-4 shrink-0 animate-spin text-primary" />
        <CheckCircle2 v-else-if="task.progress?.status === 'Done'" class="h-4 w-4 shrink-0 text-emerald-600" />
        <AlertTriangle v-else class="h-4 w-4 shrink-0 text-destructive" />
        <span class="min-w-0 truncate text-xs">
          {{ t(task.kind === "export" ? "oracleDatapump.exportTitle" : "oracleDatapump.importTitle") }} ·
          {{ task.running ? (task.progress?.percent != null ? Math.round(task.progress.percent) + "%" : "…") : task.error || task.progress?.status === "Error" ? t("oracleDatapump.failed") : t("oracleDatapump.done") }}
        </span>
        <span class="max-w-44 truncate font-mono text-xs text-muted-foreground" :title="task.dumpfile">{{ task.dumpfile }}</span>
        <Button variant="ghost" size="icon-sm" :aria-label="t('oracleDatapump.restore')" :title="t('oracleDatapump.restore')" @click="restore(task.taskId)">
          <Maximize2 class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')" :title="t('common.close')" @click="dpTask.dismiss(task.taskId)">
          <X class="h-4 w-4" />
        </Button>
      </div>
      <!-- 空闲药丸：没开始任务就最小化 -->
      <div v-if="showIdlePill" class="flex items-center gap-2 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
        <AlertTriangle class="h-4 w-4 shrink-0 text-amber-500" />
        <span class="min-w-0 truncate text-xs">{{ t("oracleDatapump.idlePill") }}</span>
        <Button variant="ghost" size="icon-sm" :aria-label="t('oracleDatapump.restore')" :title="t('oracleDatapump.restore')" @click="restoreIdle">
          <Maximize2 class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')" :title="t('common.close')" @click="dpTask.formMinimized.value = false">
          <X class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </Teleport>
</template>
