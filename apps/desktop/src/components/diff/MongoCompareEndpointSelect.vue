<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import CompareConnectionSelect from "./CompareConnectionSelect.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import type { MongoCompareEndpoint } from "@/lib/mongo/mongoCompareRuntime";

defineProps<{ label: string; disabled?: boolean; databaseOnly?: boolean; hideFilter?: boolean }>();
const endpoint = defineModel<MongoCompareEndpoint>({ required: true });
const emit = defineEmits<{ loading: [value: boolean]; collections: [value: string[]] }>();
const { t } = useI18n();
const store = useConnectionStore();
const databases = ref<string[]>([]);
const collections = ref<string[]>([]);
const error = ref("");
const busy = ref(false);
let generation = 0;
onBeforeUnmount(() => {
  generation += 1;
});

watch(
  () => [endpoint.value.connectionId, endpoint.value.database] as const,
  async ([connectionId, database]) => {
    const request = ++generation;
    databases.value = [];
    collections.value = [];
    emit("collections", []);
    error.value = "";
    if (!connectionId) {
      busy.value = false;
      emit("loading", false);
      return;
    }
    busy.value = true;
    emit("loading", true);
    try {
      await store.ensureConnected(connectionId);
      const dbs = await api.mongoListDatabases(connectionId);
      if (request !== generation) return;
      databases.value = database && !dbs.includes(database) ? [database, ...dbs] : dbs;
      if (database) {
        const items = await api.mongoListCollections(connectionId, database);
        if (request !== generation) return;
        collections.value = items.filter((item) => item.kind !== "bucket").map((item) => item.name);
        emit("collections", collections.value);
      }
    } catch (cause) {
      if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === generation) {
        busy.value = false;
        emit("loading", false);
      }
    }
  },
  { immediate: true },
);

function changeConnection(connectionId: string) {
  endpoint.value = { ...endpoint.value, connectionId, database: "", collection: "" };
}
function changeDatabase(value: unknown) {
  endpoint.value = { ...endpoint.value, database: String(value), collection: "" };
}
</script>

<template>
  <section class="min-w-0 space-y-2 rounded-md border border-border p-3" :aria-label="label">
    <h3 class="text-sm font-semibold">{{ label }}</h3>
    <CompareConnectionSelect :model-value="endpoint.connectionId" :connections="store.connections.filter((item) => item.db_type === 'mongodb')" :layout="store.sidebarLayout" :disabled="disabled" @update:model-value="changeConnection" />
    <div class="grid gap-2" :class="databaseOnly ? 'grid-cols-1' : 'grid-cols-2'">
      <Select :model-value="endpoint.database" :disabled="disabled || busy || !endpoint.connectionId" @update:model-value="changeDatabase">
        <SelectTrigger class="h-8 min-w-0 text-xs" :aria-label="`${label}: ${t('mongoCompare.database')}`"><SelectValue :placeholder="t('mongoCompare.database')" /></SelectTrigger>
        <SelectContent
          ><SelectItem v-for="database in databases" :key="database" :value="database">{{ database }}</SelectItem></SelectContent
        >
      </Select>
      <Select v-if="!databaseOnly" :model-value="endpoint.collection" :disabled="disabled || busy || !endpoint.database" @update:model-value="(value) => (endpoint = { ...endpoint, collection: String(value) })">
        <SelectTrigger class="h-8 min-w-0 text-xs" :aria-label="`${label}: ${t('mongoCompare.collection')}`"><SelectValue :placeholder="t('mongoCompare.collection')" /></SelectTrigger>
        <SelectContent
          ><SelectItem v-for="collection in collections" :key="collection" :value="collection">{{ collection }}</SelectItem></SelectContent
        >
      </Select>
    </div>
    <label v-if="!hideFilter" class="block space-y-1 text-xs"
      ><span>{{ t("mongoCompare.filter") }}</span
      ><textarea v-model="endpoint.filter" :disabled="disabled" spellcheck="false" class="w-full resize-y rounded-md border border-input bg-transparent p-2 font-mono focus-visible:outline-ring" rows="2" placeholder="{}" />
    </label>
    <p v-if="busy" class="text-xs text-muted-foreground" role="status">{{ t("mongoCompare.loadingMetadata") }}</p>
    <p v-if="error" class="break-all text-xs text-destructive" role="alert">{{ error }}</p>
  </section>
</template>
