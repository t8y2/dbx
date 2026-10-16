<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DataComparePanel from "@/components/diff/DataComparePanel.vue";
import { ExternalLink, GitCompareArrows } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import { setDataCompareDialogTransactionActive } from "@/composables/useDialogSources";
import type { DataCompareTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
  sessionId?: string | null;
  initialState?: DataCompareTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: DataCompareTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof DataComparePanel>>();
const panelTransactionActive = ref(false);

function handleTransactionStateChange(active: boolean) {
  panelTransactionActive.value = active;
  setDataCompareDialogTransactionActive(active);
}

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state || panelTransactionActive.value) return;
  open.value = false;
  useQueryStore().openDataCompare(state);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => panelRef?.requestClose(value)">
    <DialogContent class="sm:max-w-5xl max-h-[85vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 pr-16">
          <GitCompareArrows class="w-4 h-4" />
          {{ t("dataCompare.title") }}
        </DialogTitle>
      </DialogHeader>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10" :disabled="panelTransactionActive" :title="panelTransactionActive ? t('dataCompare.transactionActiveHint') : t('dataCompare.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <DataComparePanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-table="props.prefillTable"
        :session-id="props.sessionId"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @transaction-state-change="handleTransactionStateChange"
      />
    </DialogContent>
  </Dialog>
</template>
