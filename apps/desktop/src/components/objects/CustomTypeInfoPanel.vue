<script setup lang="ts">
import { computed, ref } from "vue";
import OracleCustomTypeInfoPanel from "@/components/objects/OracleCustomTypeInfoPanel.vue";
import PostgresCustomTypeInfoPanel from "@/components/objects/PostgresCustomTypeInfoPanel.vue";
import type { ConnectionConfig, CustomTypeEditorSession, CustomTypeIdentity, DatabaseType } from "@/types/database";

const props = withDefaults(
  defineProps<{
    connection: ConnectionConfig;
    database: string;
    schema: string;
    name: string;
    catalog?: string;
    databaseType?: DatabaseType;
    initialMode?: "view" | "create" | "edit" | "delete";
    requestId?: number;
    session?: CustomTypeEditorSession | null;
  }>(),
  { catalog: undefined, databaseType: undefined, initialMode: "view", requestId: 0, session: null },
);

const emit = defineEmits<{
  close: [];
  "open-source": [objectType: "TYPE" | "TYPE_BODY"];
  saved: [payload: { identity: CustomTypeIdentity; created: boolean }];
  deleted: [payload: { identity: CustomTypeIdentity }];
  dirtyChange: [dirty: boolean];
  sessionChange: [session: CustomTypeEditorSession];
}>();

const panel = ref<{
  selectTab?: (tab: string) => void;
  confirmDiscard?: () => boolean;
  refresh?: () => void | Promise<void>;
} | null>(null);

const effectiveDatabaseType = computed(() => props.databaseType ?? props.connection.db_type);
const isOracleFamily = computed(() => ["oracle", "oceanbase-oracle", "dameng"].includes(effectiveDatabaseType.value));

function selectTab(tab: string) {
  panel.value?.selectTab?.(tab);
}

function confirmDiscard(): boolean {
  return panel.value?.confirmDiscard?.() ?? true;
}

function refresh() {
  return panel.value?.refresh?.();
}

defineExpose({ selectTab, confirmDiscard, refresh });
</script>

<template>
  <OracleCustomTypeInfoPanel v-if="isOracleFamily" ref="panel" :connection="connection" :database="database" :schema="schema" :name="name" :catalog="catalog" :database-type="effectiveDatabaseType" @close="emit('close')" @open-source="emit('open-source', $event)" />
  <PostgresCustomTypeInfoPanel
    v-else
    ref="panel"
    :connection="connection"
    :database="database"
    :schema="schema"
    :name="name"
    :catalog="catalog"
    :initial-mode="initialMode"
    :request-id="requestId"
    :session="session"
    @close="emit('close')"
    @saved="emit('saved', $event)"
    @deleted="emit('deleted', $event)"
    @dirty-change="emit('dirtyChange', $event)"
    @session-change="emit('sessionChange', $event)"
  />
</template>
