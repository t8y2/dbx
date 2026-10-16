<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import FieldLineagePanel from "@/components/lineage/FieldLineagePanel.vue";
import { ExternalLink, Link } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { DatabaseType, FieldLineageTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId: string;
  prefillDatabase: string;
  prefillSchema?: string;
  prefillTable: string;
  prefillColumn: string;
  prefillDatabaseType?: DatabaseType;
  initialState?: FieldLineageTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: FieldLineageTabState | undefined];
  "open-target": [
    value: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
      columnName?: string;
    },
  ];
}>();

const panelRef = ref<InstanceType<typeof FieldLineagePanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openFieldLineage(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="h-[78vh] min-h-[560px] max-h-[780px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden gap-0 p-0 sm:max-w-[980px]">
      <DialogHeader class="border-b px-6 py-4 pr-16">
        <DialogTitle class="flex items-center gap-2 text-lg">
          <Link class="h-5 w-5" />
          {{ t("lineage.title") }}
        </DialogTitle>
      </DialogHeader>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <FieldLineagePanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :prefill-table="props.prefillTable"
        :prefill-column="props.prefillColumn"
        :prefill-database-type="props.prefillDatabaseType"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @open-target="(value) => emit('open-target', value)"
      />
    </DialogScrollContent>
  </Dialog>
</template>
