<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, AlertCircle, FolderOpen, X } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const isRevealing = ref(false);

const props = defineProps<{
  title: string;
  tableName: string;
  format: string;
  rowsExported: number;
  totalRows: number | null;
  status: string;
  errorMessage: string | null;
  filePath?: string | null;
  disableCancel?: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  "update:open": [value: boolean];
}>();

const isActive = computed(() => props.status === "Running" || props.status === "Writing");
const isFinished = computed(() => props.status === "Done" || props.status === "Error" || props.status === "Cancelled");
const canRevealFile = computed(() => props.status === "Done" && !!props.filePath && isTauriRuntime());
const progressPercent = computed(() => {
  if (!props.totalRows || props.totalRows <= 0) return 0;
  return Math.min(100, Math.round((props.rowsExported / props.totalRows) * 100));
});
const rowsText = computed(() => {
  if (props.totalRows) {
    return t("exportProgress.rowsCount", {
      exported: props.rowsExported.toLocaleString(),
      total: props.totalRows.toLocaleString(),
    });
  }
  return t("exportProgress.rowsExported", { count: props.rowsExported.toLocaleString() });
});

async function revealExportFile() {
  if (!props.filePath || isRevealing.value) return;
  isRevealing.value = true;
  try {
    await api.revealPathInFileManager(props.filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(t("exportProgress.openFolderFailed", { message }), 5000);
  } finally {
    isRevealing.value = false;
  }
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (v: boolean) => {
        if (!isActive) emit('update:open', v);
      }
    "
  >
    <DialogContent class="sm:max-w-md" :class="{ 'pointer-events-none': isActive }" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <div class="py-4 space-y-4">
        <!-- Table name and format info -->
        <div class="text-sm text-muted-foreground">{{ tableName }} (.{{ format }})</div>

        <!-- Progress bar -->
        <div class="w-full bg-muted rounded-full h-2 overflow-hidden">
          <template v-if="status === 'Running' || status === 'Writing'">
            <div v-if="totalRows" class="h-full bg-primary rounded-full transition-[width] duration-300" :style="{ width: `${progressPercent}%` }" />
            <div v-else class="h-full w-full overflow-hidden rounded-full">
              <div class="export-progress-indeterminate h-full rounded-full bg-primary" />
            </div>
          </template>
          <div v-else-if="status === 'Done'" class="h-full bg-green-500 rounded-full" style="width: 100%" />
        </div>

        <!-- Status message -->
        <div class="flex items-center gap-2 text-sm">
          <template v-if="status === 'Running'">
            <Loader2 class="h-4 w-4 animate-spin text-primary" />
            <span>{{ t("exportProgress.fetching") }}</span>
          </template>
          <template v-else-if="status === 'Writing'">
            <Loader2 class="h-4 w-4 animate-spin text-primary" />
            <span>{{ t("exportProgress.writing") }}</span>
          </template>
          <template v-else-if="status === 'Done'">
            <CheckCircle2 class="h-4 w-4 text-green-500" />
            <span class="text-green-700 dark:text-green-400">{{ t("exportProgress.done") }}</span>
          </template>
          <template v-else-if="status === 'Error'">
            <XCircle class="h-4 w-4 text-destructive" />
            <span class="text-destructive">{{ errorMessage || t("exportProgress.error") }}</span>
          </template>
          <template v-else-if="status === 'Cancelled'">
            <AlertCircle class="h-4 w-4 text-yellow-500" />
            <span class="text-yellow-700 dark:text-yellow-400">{{ t("exportProgress.cancelled") }}</span>
          </template>
        </div>

        <!-- Row count -->
        <div class="text-xs text-muted-foreground tabular-nums">
          {{ rowsText }}
        </div>
      </div>

      <DialogFooter>
        <template v-if="isActive">
          <Button variant="outline" size="sm" :disabled="disableCancel" @click="emit('cancel')">
            <X class="h-3.5 w-3.5 mr-1" />
            {{ t("exportProgress.cancel") }}
          </Button>
        </template>
        <template v-else-if="isFinished">
          <Button v-if="canRevealFile" size="sm" :disabled="isRevealing" @click="revealExportFile">
            <Loader2 v-if="isRevealing" class="mr-1 h-3.5 w-3.5 animate-spin" />
            <FolderOpen v-else class="mr-1 h-3.5 w-3.5" />
            {{ t("exportProgress.openFolder") }}
          </Button>
          <Button variant="outline" size="sm" @click="emit('update:open', false)">
            {{ t("exportProgress.close") }}
          </Button>
        </template>
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
