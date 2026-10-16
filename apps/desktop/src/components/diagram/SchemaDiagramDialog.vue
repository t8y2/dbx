<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import SchemaDiagramPanel from "@/components/diagram/SchemaDiagramPanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { SchemaDiagramTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  focusTableName?: string;
  focusTableNames?: string[];
  initialState?: SchemaDiagramTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: SchemaDiagramTabState | undefined];
  "open-target": [
    value: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
    },
  ];
}>();

const panelRef = ref<InstanceType<typeof SchemaDiagramPanel>>();

/** Window-level fullscreen: the shell sizes the DialogContent for it. */
const isFullscreen = ref(false);
const dialogStyle = computed(() =>
  isFullscreen.value
    ? { width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%", borderRadius: "0" }
    : {
        width: "94vw",
        height: "86vh",
        maxWidth: "94vw",
        maxHeight: "86vh",
      },
);

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openSchemaDiagram(state);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="['gap-0 p-0 overflow-hidden flex flex-col min-w-0 sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw]', isFullscreen ? 'dbx-diagram-fullscreen' : '']" :style="dialogStyle" :portal-class="isFullscreen ? 'p-0' : undefined">
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-20" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <SchemaDiagramPanel
        ref="panelRef"
        v-model:open="open"
        :prefill-connection-id="props.prefillConnectionId"
        :prefill-database="props.prefillDatabase"
        :prefill-schema="props.prefillSchema"
        :focus-table-name="props.focusTableName"
        :focus-table-names="props.focusTableNames"
        :initial-state="props.initialState"
        @update:initial-state="(state) => emit('update:initial-state', state)"
        @fullscreen-change="(value) => (isFullscreen = value)"
        @open-target="(value) => emit('open-target', value)"
      />
    </DialogContent>
  </Dialog>
</template>
