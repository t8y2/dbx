<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import MongoImportPanel from "@/components/document/MongoImportPanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { MongoImportTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
  initialState?: MongoImportTabState;
}>();

const emit = defineEmits<{
  completed: [];
  "update:initial-state": [state: MongoImportTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof MongoImportPanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openMongoImport(state);
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) open = false;
        else open = true;
      }
    "
  >
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 flex-col overflow-hidden sm:max-w-[980px]" aria-labelledby="mongo-import-title">
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <MongoImportPanel ref="panelRef" v-model:open="open" :connection-id="props.connectionId" :database="props.database" :collection="props.collection" :initial-state="props.initialState" @update:initial-state="(state) => emit('update:initial-state', state)" @completed="emit('completed')" />
    </DialogScrollContent>
  </Dialog>
</template>
