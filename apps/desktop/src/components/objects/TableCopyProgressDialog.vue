<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTableCopyTaskStore } from "@/stores/tableCopyTaskStore";

const store = useTableCopyTaskStore();
const task = computed(() => store.displayedTask);
const isCurrent = computed(() => task.value === store.task);
const { t } = useI18n();
const now = ref(Date.now());
const timer = setInterval(() => {
  now.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));
const elapsed = computed(() => Math.max(0, Math.floor(((task.value?.finishedAt ?? now.value) - (task.value?.startedAt ?? now.value)) / 1000)));
const working = computed(() => isCurrent.value && store.busy && task.value?.status !== "unknown");
</script>

<template>
  <Dialog
    :open="store.open"
    @update:open="
      (value) => {
        if (!value) store.close();
      }
    "
  >
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t("tableCopyTask.title") }}</DialogTitle>
      </DialogHeader>
      <template v-if="task">
        <div class="flex items-center gap-2" role="status" aria-live="polite">
          <Loader2 v-if="working" class="size-4 shrink-0 animate-spin" />
          <span>{{ t(`tableCopyTask.${working ? (task.status === "cancelling" ? "cancelling" : task.phase) : task.status}`) }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("tableCopyTask.elapsed", { seconds: elapsed }) }}</p>
        <p v-if="working && task.phase === 'data'" class="text-xs text-muted-foreground">{{ t("tableCopyTask.visibility") }}</p>
        <div class="max-h-60 space-y-2 overflow-y-auto rounded border p-3 text-sm">
          <div v-for="(target, index) in task.targets" :key="index" class="space-y-1">
            <div class="flex justify-between gap-3">
              <span class="break-all">{{ target.name }}</span>
              <span class="shrink-0 text-muted-foreground">{{ t(`tableCopyTask.${target.status}`) }}</span>
            </div>
            <p v-if="target.structureCreated" class="text-xs text-muted-foreground">{{ t("tableCopyTask.structureCreated") }}</p>
            <p v-if="target.copiedRows !== undefined" class="text-xs text-muted-foreground">{{ t("tableCopyTask.copiedRows", { count: target.copiedRows }) }}</p>
            <p v-if="target.error" class="break-words text-xs text-destructive">{{ target.error }}</p>
          </div>
        </div>
        <p v-if="task.status === 'unknown'" class="text-sm text-destructive">{{ t("tableCopyTask.unknownHint") }}</p>
        <p v-if="['failed', 'cancelled', 'unknown'].includes(task.status)" class="text-xs text-muted-foreground">{{ t("tableCopyTask.retained") }}</p>
        <p v-if="task.refreshError" class="break-words text-sm text-destructive">{{ t("tableCopyTask.refreshFailed", { message: task.refreshError }) }}</p>
        <p v-if="task.cancelError" class="break-words text-sm text-destructive">{{ t("tableCopyTask.cancelFailed", { message: task.cancelError }) }}</p>
        <DialogFooter>
          <Button v-if="isCurrent && task.status === 'unknown' && store.busy" variant="outline" :disabled="store.cancelSending" @click="store.checkCompletion()">{{ t("tableCopyTask.checkCompletion") }}</Button>
          <Button v-if="isCurrent && store.busy && task.phase !== 'refreshing'" variant="outline" :disabled="store.cancelSending" @click="store.cancel()">{{ t(task.status === "cancelling" ? "tableCopyTask.retryCancel" : "tableCopyTask.cancel") }}</Button>
          <Button @click="store.close()">{{ t(working ? "tableCopyTask.hide" : "tableCopyTask.close") }}</Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
