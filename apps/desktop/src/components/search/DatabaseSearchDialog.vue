<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ExternalLink, Search } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import DatabaseSearchPanel from "@/components/search/DatabaseSearchPanel.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { DatabaseSearchTabState } from "@/types/database";
import type { NavigationTarget } from "@/composables/useNavigationTargets";

const props = defineProps<{
  open: boolean;
  prefillConnectionId: string;
  prefillDatabase: string;
  prefillSchema?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "open-target": [value: NavigationTarget];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const connection = computed(() => (props.prefillConnectionId ? connectionStore.getConfig(props.prefillConnectionId) : undefined));
const scopeLabel = computed(() => [connection.value?.name, props.prefillDatabase, props.prefillSchema].filter(Boolean).join(" / "));

const currentState = ref<DatabaseSearchTabState | undefined>(undefined);
const panelRef = ref<InstanceType<typeof DatabaseSearchPanel> | null>(null);

function onStateUpdate(state: DatabaseSearchTabState) {
  currentState.value = state;
}

function openInTab() {
  const state = currentState.value ?? panelRef.value?.getCurrentState();
  dialogOpen.value = false;
  queryStore.openDatabaseSearch(props.prefillConnectionId, props.prefillDatabase, props.prefillSchema, state);
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 max-w-4xl flex-col overflow-hidden gap-0 p-0">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <div class="flex items-center justify-between pr-8">
          <div>
            <DialogTitle class="flex items-center gap-2">
              <Search class="h-5 w-5" />
              {{ t("databaseSearch.title") }}
            </DialogTitle>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mt-1">
              <span>{{ scopeLabel }}</span>
              <Badge v-if="props.prefillSchema" variant="secondary">{{ props.prefillSchema }}</Badge>
            </div>
          </div>
          <Button variant="outline" size="sm" class="gap-1.5 text-xs shrink-0" @click="openInTab">
            <ExternalLink class="h-3.5 w-3.5" />
            {{ t("databaseSearch.openInTab") }}
          </Button>
        </div>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <DatabaseSearchPanel ref="panelRef" :connection-id="props.prefillConnectionId" :database="props.prefillDatabase" :schema="props.prefillSchema" :in-dialog="true" @update:state="onStateUpdate" @open-target="emit('open-target', $event)" @open-in-tab="openInTab" />
      </div>

      <DialogFooter class="shrink-0 border-t px-5 py-3">
        <Button variant="outline" @click="dialogOpen = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
