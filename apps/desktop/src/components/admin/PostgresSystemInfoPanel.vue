<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { usePostgresAdminSession } from "@/composables/usePostgresAdminSession";
import { POSTGRES_SYSTEM_CATEGORIES, supportsPostgresAdministration, type PostgresSystemCategory } from "@/lib/database/postgresAdministration";
import { postgresSystemInfoSql } from "@/lib/database/postgresSystemInfo";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import PostgresAdminTable from "./PostgresAdminTable.vue";
const props = defineProps<{ connection: ConnectionConfig; category?: PostgresSystemCategory }>();
const { t } = useI18n();
const connections = useConnectionStore();
const queryStore = useQueryStore();
const { query } = usePostgresAdminSession(() => props.connection);
const connected = computed(() => connections.connectedIds.has(props.connection.id));
const database = ref(props.connection.database || "");
const databases = ref<string[]>([]);
const category = ref<PostgresSystemCategory>(props.category ?? "accessMethods");
const result = ref<QueryResult | null>(null);
const loading = ref(false);
const error = ref("");
const sampledAt = ref("");
let generation = 0;
watch(
  () => props.category,
  (value) => {
    if (value) category.value = value;
  },
);
watch(
  [() => JSON.stringify(props.connection), connected],
  async () => {
    database.value = props.connection.database || "";
    const id = props.connection.id;
    databases.value = [];
    try {
      if (!connected.value) return;
      const items = await api.listDatabases(id);
      if (id === props.connection.id) databases.value = items.map((item) => item.name);
    } catch {
      /* The configured database remains usable when listing is denied. */
    }
  },
  { immediate: true },
);
async function load() {
  const ticket = ++generation;
  result.value = null;
  sampledAt.value = "";
  error.value = "";
  if (!supportsPostgresAdministration(props.connection)) {
    error.value = t("postgresAdmin.unsupported");
    return;
  }
  if (!connected.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const data = await query(database.value, postgresSystemInfoSql(category.value));
    if (ticket !== generation) return;
    result.value = data;
    sampledAt.value = new Date().toLocaleTimeString();
  } catch (e) {
    if (ticket === generation) error.value = String(e);
  } finally {
    if (ticket === generation) loading.value = false;
  }
}
watch([() => JSON.stringify(props.connection), connected, database, category], () => void load(), { immediate: true });
onBeforeUnmount(() => generation++);
function openSql() {
  queryStore.createTab(props.connection.id, database.value, undefined, "query", undefined, postgresSystemInfoSql(category.value));
}
</script>
<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col gap-3 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-sm font-semibold">{{ t("postgresAdmin.systemInfo") }}</h2>
      <label class="flex items-center gap-2 text-xs"
        >{{ t("postgresAdmin.database") }}
        <select v-model="database" class="h-7 max-w-64 rounded border bg-background px-2">
          <option :value="connection.database || ''">{{ connection.database || connection.username }}</option>
          <option v-for="name in databases.filter((name) => name !== (connection.database || ''))" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-2 text-xs"
        >{{ t("postgresAdmin.category") }}
        <select v-model="category" class="h-7 rounded border bg-background px-2">
          <option v-for="item in POSTGRES_SYSTEM_CATEGORIES" :key="item" :value="item">{{ t(`postgresAdmin.${item}`) }}</option>
        </select>
      </label>
      <Button size="sm" variant="outline" :disabled="loading" @click="load">{{ t("postgresAdmin.refresh") }}</Button>
      <Button size="sm" variant="ghost" @click="openSql">{{ t("postgresAdmin.showSql") }}</Button>
    </div>
    <p class="text-xs text-muted-foreground">{{ connection.name }} / {{ database || connection.username }} · {{ t("postgresAdmin.visibility") }}</p>
    <p v-if="sampledAt" class="text-xs text-muted-foreground">{{ t("postgresAdmin.sampled", { time: sampledAt }) }}</p>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <PostgresAdminTable v-if="!loading" :result="result" />
    <p v-else role="status" class="text-xs text-muted-foreground">{{ t("common.loading") }}</p>
  </section>
</template>
