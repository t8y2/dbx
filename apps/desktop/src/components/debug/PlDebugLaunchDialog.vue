<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DebugParamsDialog from "./DebugParamsDialog.vue";
import PlDebugCompilePanel from "./PlDebugCompilePanel.vue";
import { plDebugLaunchOpen, plDebugLaunchTarget } from "./plDebugLaunch";
import { useQueryStore } from "@/stores/queryStore";
import { usePlDebugStore } from "@/stores/plDebugStore";
import type { PlDebugInspectResult } from "@/lib/debug/plDebugProtocol";
import i18n from "@/i18n";

/**
 * Single host for every "Debug PL/SQL" entry point. It loads the target
 * routine's parameters, then hands them to the existing DebugParamsDialog and
 * opens the debugger tab once a session starts.
 */
const queryStore = useQueryStore();
const store = usePlDebugStore();

const inspection = ref<PlDebugInspectResult | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
let loadToken = 0;
let prepareTypes = false;

const target = computed(() => plDebugLaunchTarget.value);
const routineLabel = computed(() => {
  const current = target.value;
  if (!current) return "";
  if (current.objectType === "ANONYMOUS") return i18n.global.t("plDebug.launch.anonymousTitle");
  return current.packageName ? `${current.packageName}.${current.objectName}` : current.objectName;
});

async function refreshPreview() {
  const current = target.value;
  // Only the newest launch may publish parameters: a second "Debug" click
  // while the first metadata query is still running must win.
  const token = ++loadToken;
  inspection.value = null;
  loadError.value = null;
  if (!current) return;
  loading.value = true;
  try {
    if (current.objectType !== "ANONYMOUS" && current.objectType !== "PROCEDURE" && current.objectType !== "FUNCTION") throw new Error(i18n.global.t("plDebug.launch.unsupported"));
    const loaded = await store.inspectTarget(
      current.connectionId,
      current.database,
      current.objectType === "ANONYMOUS" ? undefined : { schema: current.schema, objectType: current.objectType, objectName: current.objectName, packageName: current.packageName, ...(prepareTypes ? { metadataPreparation: "type_only" as const } : {}) },
    );
    if (token !== loadToken) return;
    inspection.value = loaded;
  } catch (caught) {
    if (token !== loadToken) return;
    loadError.value = String(caught);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(
  () => plDebugLaunchTarget.value,
  () => {
    prepareTypes = false;
    void refreshPreview();
  },
  { immediate: true },
);

function prepareTypePreview() {
  if (!target.value || !["oracle", "oceanbase-oracle"].includes(target.value.databaseType ?? "") || target.value.objectType === "ANONYMOUS") return;
  prepareTypes = true;
  void refreshPreview();
}

function onStarted() {
  const current = store.publicSnapshot ?? store.pendingStart;
  if (!current) return;
  queryStore.openPlDebugTab({ connectionId: current.connectionId, database: current.database, schema: store.target?.schema ?? undefined, title: routineLabel.value });
}
</script>

<template>
  <DebugParamsDialog
    v-if="target"
    v-model:open="plDebugLaunchOpen"
    :object-type="target.objectType"
    :object-name="target.objectName"
    :package-name="target.packageName"
    :source="target.source"
    :schema="target.schema"
    :preview="inspection"
    :loading="loading"
    :load-error="loadError"
    :database="target.database"
    :connection-id="target.connectionId"
    :allow-type-preparation="['oracle', 'oceanbase-oracle'].includes(target.databaseType ?? '') && target.objectType !== 'ANONYMOUS'"
    @started="onStarted"
    @recover="onStarted"
    @refresh="refreshPreview"
    @prepare-types="prepareTypePreview"
  >
    <template #compilation>
      <PlDebugCompilePanel v-if="['oracle', 'oceanbase-oracle'].includes(target.databaseType ?? '') && target.objectType !== 'ANONYMOUS'" :target="target" :open="plDebugLaunchOpen" :preparing="loading" @compiled="refreshPreview" @edit="plDebugLaunchOpen = false" />
    </template>
  </DebugParamsDialog>
</template>
