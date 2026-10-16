<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRightLeft, Loader2, Minimize2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import DataTransferProgressCard from "@/components/transfer/DataTransferProgressCard.vue";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ task: ExportTask }>();
const { cancelTask } = useExportTracker();
const isActive = computed(() => ["Running", "Writing", "Cancelling"].includes(props.task.status));
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

      <DataTransferProgressCard :task="task" />

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
