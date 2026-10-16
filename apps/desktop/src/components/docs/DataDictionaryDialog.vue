<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DataDictionaryPanel from "@/components/docs/DataDictionaryPanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { SchemaSnapshot } from "@/docs/types";
import type { DataDictionaryTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTableNames?: string[];
  snapshot?: SchemaSnapshot | null;
  initialState?: DataDictionaryTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: DataDictionaryTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof DataDictionaryPanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openDataDictionary(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(760px,88vh)] w-[min(980px,94vw)] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[94vw]">
      <DialogHeader class="border-b px-4 py-3 pr-16">
        <DialogTitle>{{ t("dataDictionary.title") }}</DialogTitle>
      </DialogHeader>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <DataDictionaryPanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-table-names="props.prefillTableNames"
        :snapshot="props.snapshot ?? null"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
      />
    </DialogContent>
  </Dialog>
</template>
