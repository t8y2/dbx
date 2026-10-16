<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DataTransferPanel from "@/components/transfer/DataTransferPanel.vue";
import DataTransferProgressDialog from "@/components/transfer/DataTransferProgressDialog.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import { useExportTracker } from "@/composables/useExportTracker";
import { setDataTransferDialogBusy } from "@/composables/useDialogSources";
import type { TransferTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillCatalog?: string;
  prefillSchema?: string;
  prefillTables?: string[];
  prefillTargetConnectionId?: string;
  prefillTargetDatabase?: string;
  prefillTargetSchema?: string;
  taskId?: string | null;
  initialState?: TransferTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: TransferTabState | undefined];
}>();

const { tasks } = useExportTracker();

const trackedTransferTask = computed(() => {
  const id = props.taskId;
  if (!id) return undefined;
  return tasks.value.find((task) => task.exportId === id && task.kind === "data-transfer");
});

const transferDialogStyle = {
  width: "min(1120px, calc(100vw - 2rem))",
  height: "min(80vh, calc(var(--dbx-viewport-height) - 2rem))",
  minWidth: "min(780px, calc(100vw - 2rem))",
  minHeight: "min(480px, calc(var(--dbx-viewport-height) - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
  maxHeight: "calc(var(--dbx-viewport-height) - 2rem)",
} as const;

const panelRef = ref<InstanceType<typeof DataTransferPanel>>();
const panelBusy = ref(false);

function handleBusyChange(busy: boolean) {
  panelBusy.value = busy;
  setDataTransferDialogBusy(busy);
}

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state || panelBusy.value) return;
  open.value = false;
  useQueryStore().openDataTransfer(state);
}
</script>

<template>
  <DataTransferProgressDialog v-if="trackedTransferTask" v-model:open="open" :task="trackedTransferTask" />
  <Dialog v-else v-model:open="open">
    <DialogContent class="dbx-transfer-dialog sm:max-w-[1120px] max-h-[80vh] flex flex-col overflow-hidden resize" :style="transferDialogStyle" @interact-outside.prevent>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :disabled="panelBusy" :title="panelBusy ? t('workspace.runStateLockedHint') : t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="w-4 h-4" />
      </Button>
      <DataTransferPanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-catalog="props.prefillCatalog"
        :prefill-schema="props.prefillSchema"
        :prefill-tables="props.prefillTables"
        :prefill-target-connection-id="props.prefillTargetConnectionId"
        :prefill-target-database="props.prefillTargetDatabase"
        :prefill-target-schema="props.prefillTargetSchema"
        :task-id="props.taskId"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @busy-state-change="handleBusyChange"
      />
    </DialogContent>
  </Dialog>
</template>

<style>
html.dbx-legacy-webview [data-slot="dialog-content"].dbx-transfer-dialog[class~="max-w-sm"] {
  /* Override the legacy default cap without pinning width, so native resize remains effective. */
  max-width: calc(100vw - 2rem) !important;
}
</style>
