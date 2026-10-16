<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import MongoDatabaseDumpPanel from "@/components/document/MongoDatabaseDumpPanel.vue";
import { ExternalLink } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import type { MongoDumpTabState } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  mode: "dump" | "restore";
  initialState?: MongoDumpTabState;
}>();

const emit = defineEmits<{
  "update:initial-state": [state: MongoDumpTabState | undefined];
}>();

const panelRef = ref<InstanceType<typeof MongoDatabaseDumpPanel>>();

/** Icon action in the dialog header, left of the close button. */
function handleOpenInTab() {
  const state = panelRef.value?.getCurrentState();
  if (!state) return;
  open.value = false;
  useQueryStore().openMongoDump(state);
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) open = false;
      }
    "
  >
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-4rem)] min-h-0 flex-col overflow-hidden sm:max-w-[860px]">
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" :title="t('workspace.openInTab')" @click="handleOpenInTab">
        <ExternalLink class="h-4 w-4" />
      </Button>
      <MongoDatabaseDumpPanel ref="panelRef" v-model:open="open" :connection-id="props.connectionId" :database="props.database" :mode="props.mode" :initial-state="props.initialState" @update:initial-state="(state) => emit('update:initial-state', state)" />
    </DialogScrollContent>
  </Dialog>
</template>
