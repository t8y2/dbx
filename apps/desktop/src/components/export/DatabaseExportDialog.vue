<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DatabaseExportPanel from "@/components/export/DatabaseExportPanel.vue";
import { Download, ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { DatabaseExportTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
  prefillTables?: string[];
  prefillAllDatabases?: boolean;
  initialState?: DatabaseExportTabState;
}>();

const emit = defineEmits<{
  openConnectionSettings: [connectionId: string];
  "update:initial-state": [state: DatabaseExportTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof DatabaseExportPanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openDatabaseExport(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[480px] max-h-[80vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 pr-16">
          <Download class="w-4 h-4" />
          {{ t("databaseExport.title") }}
        </DialogTitle>
      </DialogHeader>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <DatabaseExportPanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-table="props.prefillTable"
        :prefill-tables="props.prefillTables"
        :prefill-all-databases="props.prefillAllDatabases"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @open-connection-settings="(connectionId) => emit('openConnectionSettings', connectionId)"
      />
    </DialogContent>
  </Dialog>
</template>
