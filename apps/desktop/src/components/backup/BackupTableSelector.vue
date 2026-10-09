<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import TableMultiSelect from "@/components/diff/TableMultiSelect.vue";
import { databaseBackupTableSelectionScopeKey, databaseBackupTableTargetKey, type DatabaseBackupTableTarget, type DatabaseBackupTableSelectionState } from "@/lib/backup/scheduledDatabaseBackup";

const props = defineProps<{
  connectionId: string;
  databaseType?: string;
  databases: string[];
  modelValue: DatabaseBackupTableTarget[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: DatabaseBackupTableTarget[]];
  stateChange: [value: DatabaseBackupTableSelectionState];
}>();
const { t } = useI18n();
const tables = ref<DatabaseBackupTableTarget[]>([]);
const loading = ref(false);
const loadError = ref(false);
const loaded = ref(false);
const loadedScopeKey = ref("");
let generation = 0;
const scopeKey = computed(() => databaseBackupTableSelectionScopeKey(props.connectionId, props.databaseType, props.databases));
const available = computed(() => new Map(tables.value.map((target) => [databaseBackupTableTargetKey(target), target])));
const selectedKeys = computed(() => props.modelValue.map(databaseBackupTableTargetKey));
const missing = computed(() => (loaded.value && !loadError.value ? props.modelValue.filter((target) => !available.value.has(databaseBackupTableTargetKey(target))) : []));
const labels = computed(() => Object.fromEntries(tables.value.map((target) => [databaseBackupTableTargetKey(target), label(target)])));
const searchValues = computed(() => Object.fromEntries(tables.value.map((target) => [databaseBackupTableTargetKey(target), [target.database, target.schema, target.table].join(".")])));
const ready = computed(() => loadedScopeKey.value === scopeKey.value && loaded.value && !loading.value && !loadError.value && props.databases.length > 0 && props.modelValue.length > 0 && missing.value.length === 0);
watch(
  () => ({ scopeKey: scopeKey.value, ready: ready.value }),
  (state) => emit("stateChange", state),
  { immediate: true, flush: "sync" },
);

function label(target: DatabaseBackupTableTarget): string {
  // Quoting each part makes names containing dots unambiguous in the picker.
  const parts = props.databaseType === "mysql" ? [target.database, target.table] : [target.database, target.schema, target.table];
  const quote = props.databaseType === "mysql" ? "`" : '"';
  return parts.map((part) => `${quote}${part.replaceAll(quote, quote + quote)}${quote}`).join(".");
}

async function loadTables() {
  const current = ++generation;
  const requestedScopeKey = scopeKey.value;
  const connectionId = props.connectionId;
  const databaseType = props.databaseType;
  const databases = [...props.databases];
  tables.value = [];
  loaded.value = false;
  loadError.value = false;
  loading.value = !!connectionId && databases.length > 0;
  if (!connectionId || databases.length === 0) return;
  try {
    if (databaseType !== "mysql" && databaseType !== "postgres") throw new Error("Unsupported backup connection");
    const result = await Promise.all(
      databases.map(async (database) => {
        const schemas = databaseType === "mysql" ? [database] : (await api.listSchemas(connectionId, database)).filter((schema) => schema !== "information_schema" && !schema.startsWith("pg_"));
        const groups = await Promise.all(schemas.map(async (schema) => (await api.listTables(connectionId, database, schema)).map((table) => ({ database, schema, table: table.name }))));
        return groups.flat();
      }),
    );
    if (current !== generation) return;
    tables.value = [...new Map(result.flat().map((target) => [databaseBackupTableTargetKey(target), target])).values()].sort((left, right) => label(left).localeCompare(label(right)));
    loadedScopeKey.value = requestedScopeKey;
    loaded.value = true;
  } catch {
    if (current === generation) loadError.value = true;
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(
  scopeKey,
  (_next, previous) => {
    if (previous) {
      // Removing a database explicitly removes its selected tables too. A new
      // connection must never inherit a table selection from the prior source.
      const oldConnectionId = JSON.parse(previous)[0];
      const kept = oldConnectionId === props.connectionId ? props.modelValue.filter((target) => props.databases.includes(target.database)) : [];
      if (kept.length !== props.modelValue.length) emit("update:modelValue", kept);
    }
    void loadTables();
  },
  { immediate: true, flush: "sync" },
);

function selectKeys(keys: string[]) {
  if (loading.value || loadError.value) return;
  const previous = new Map(props.modelValue.map((target) => [databaseBackupTableTargetKey(target), target]));
  emit(
    "update:modelValue",
    keys.map((key) => available.value.get(key) ?? previous.get(key)).filter((target): target is DatabaseBackupTableTarget => !!target),
  );
}
function removeMissing(target: DatabaseBackupTableTarget) {
  emit(
    "update:modelValue",
    props.modelValue.filter((value) => databaseBackupTableTargetKey(value) !== databaseBackupTableTargetKey(target)),
  );
}
onBeforeUnmount(() => {
  generation += 1;
});
</script>

<template>
  <div class="space-y-2" data-backup-table-selector>
    <p v-if="databases.length === 0" class="text-xs text-muted-foreground">{{ t("databaseBackup.selectDatabasesForTables") }}</p>
    <template v-else>
      <div class="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" :disabled="loading" @click="loadTables">{{ t("common.refresh") }}</Button>
        <Button type="button" variant="ghost" size="sm" :disabled="modelValue.length === 0" @click="emit('update:modelValue', [])">{{ t("common.clear") }}</Button>
      </div>
      <p v-if="loading" class="text-xs text-muted-foreground">{{ t("common.loading") }}</p>
      <p v-if="loadError" class="text-xs text-destructive">{{ t("databaseBackup.tableListLoadFailed") }}</p>
      <TableMultiSelect :tables="[...available.keys()]" :labels="labels" :search-values="searchValues" :model-value="selectedKeys" :disabled="loading || loadError" @update:model-value="selectKeys" />
      <div v-if="missing.length" class="space-y-1 text-xs text-destructive">
        <p>{{ t("databaseBackup.selectedTablesUnavailable") }}</p>
        <button v-for="target in missing" :key="databaseBackupTableTargetKey(target)" type="button" class="block text-left underline" :aria-label="`${t('common.remove')}: ${label(target)}`" @click="removeMissing(target)">{{ label(target) }} · {{ t("common.remove") }}</button>
      </div>
    </template>
  </div>
</template>
