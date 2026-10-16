<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DataGeneratePanel from "@/components/generate/DataGeneratePanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { DataGenerateTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
  sessionId?: string | null;
  initialState?: DataGenerateTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: DataGenerateTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof DataGeneratePanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openDataGenerate(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="max-w-[1100px] pt-12">
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <DataGeneratePanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-table="props.prefillTable"
        :session-id="props.sessionId"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
      />
    </DialogScrollContent>
  </Dialog>
</template>
