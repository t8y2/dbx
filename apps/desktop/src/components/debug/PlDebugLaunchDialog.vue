<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DebugParamsDialog from "./DebugParamsDialog.vue";
import { plDebugLaunchOpen, plDebugLaunchTarget } from "./plDebugLaunch";
import { loadRoutineParameters } from "@/lib/table/routineParameters";
import { useQueryStore } from "@/stores/queryStore";
import type { PlDebugParam } from "@/lib/backend/pl-debug-tauri";

/**
 * Single host for every "Debug PL/SQL" entry point. It loads the target
 * routine's parameters, then hands them to the existing DebugParamsDialog and
 * opens the debugger tab once a session starts.
 */
const queryStore = useQueryStore();

const params = ref<PlDebugParam[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
let loadToken = 0;

const target = computed(() => plDebugLaunchTarget.value);
const routineLabel = computed(() => {
  const current = target.value;
  if (!current) return "";
  return current.packageName ? `${current.packageName}.${current.objectName}` : current.objectName;
});

watch(
  () => plDebugLaunchTarget.value,
  async (current) => {
    // Only the newest launch may publish parameters: a second "Debug" click
    // while the first metadata query is still running must win.
    const token = ++loadToken;
    params.value = [];
    loadError.value = null;
    if (!current) return;
    loading.value = true;
    try {
      const loaded = await loadRoutineParameters({
        connectionId: current.connectionId,
        database: current.database,
        databaseType: current.databaseType,
        schema: current.schema,
        routineName: current.objectName,
        packageName: current.packageName,
      });
      if (token !== loadToken) return;
      params.value = loaded.map((parameter) => ({ name: parameter.name, mode: parameter.mode, type: parameter.dataType, value: "" }));
    } catch (caught) {
      if (token !== loadToken) return;
      loadError.value = String(caught);
    } finally {
      if (token === loadToken) loading.value = false;
    }
  },
);

function onStarted() {
  const current = plDebugLaunchTarget.value;
  if (!current) return;
  queryStore.openPlDebugTab({ connectionId: current.connectionId, database: current.database, schema: current.schema, title: routineLabel.value });
}
</script>

<template>
  <DebugParamsDialog
    v-if="target"
    v-model:open="plDebugLaunchOpen"
    :object-type="target.objectType"
    :object-name="target.objectName"
    :package-name="target.packageName"
    :schema="target.schema"
    :params="params"
    :loading="loading"
    :load-error="loadError"
    :database="target.database"
    :connection-id="target.connectionId"
    @started="onStarted"
  />
</template>
