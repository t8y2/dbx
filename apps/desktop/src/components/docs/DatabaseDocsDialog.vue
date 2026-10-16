<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DatabaseDocsPanel from "@/components/docs/DatabaseDocsPanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { DatabaseDocsTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  initialState?: DatabaseDocsTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: DatabaseDocsTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof DatabaseDocsPanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openDatabaseDocs(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="w-[94vw] max-w-[94vw] sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw] h-[86vh] max-h-[86vh] gap-0 p-0 overflow-hidden flex flex-col">
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <DatabaseDocsPanel ref="panelRef" v-model:open="open" :prefill-connection-id="props.prefillConnectionId" :prefill-database="props.prefillDatabase" :prefill-schema="props.prefillSchema" :initial-state="props.initialState" @update:initial-state="(state) => emit('update:initial-state', state)" />
    </DialogContent>
  </Dialog>
</template>
