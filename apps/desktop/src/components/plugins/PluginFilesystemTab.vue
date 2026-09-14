<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import PluginFileManager from "@/components/plugins/PluginFileManager.vue";
import PluginRefreshState from "@/components/plugins/PluginRefreshState.vue";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import type { InstalledPlugin } from "@/types/database";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{
  pluginId: string;
  providerId: string;
  connectionId?: string;
  rootUri?: string;
  initialUri?: string;
}>();

const { t, locale: appLocale } = useI18n();
const connectionStore = useConnectionStore();

const plugins = ref<InstalledPlugin[]>([]);
const loading = ref(true);
const error = ref("");
const deferred = ref(false);
let loadGeneration = 0;
const entry = computed(() =>
  createFrontendPluginRegistry(plugins.value, appLocale.value)
    .listFilesystemProviders()
    .find((candidate) => candidate.plugin.manifest.id === props.pluginId && candidate.contribution.id === props.providerId),
);
const provider = computed(() => (entry.value ? { ...entry.value.contribution, root_uri: props.rootUri || entry.value.contribution.root_uri } : undefined));
const fileManagerRef = ref<InstanceType<typeof PluginFileManager>>();

async function load() {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = "";
  try {
    const installed = await api.listPlugins();
    if (generation !== loadGeneration) return;
    plugins.value = installed;
    if (!entry.value) throw new Error(t("pluginPlatform.filesystemUnavailable", { pluginId: props.pluginId, providerId: props.providerId }));
  } catch (cause) {
    if (generation !== loadGeneration) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function refresh() {
  deferred.value = false;
  loading.value = true;
  error.value = "";
  try {
    if (props.connectionId) await connectionStore.ensureConnected(props.connectionId);
    if (fileManagerRef.value?.refresh) {
      loading.value = false;
      return await fileManagerRef.value.refresh();
    }
    await load();
  } catch (cause) {
    loading.value = false;
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function start() {
  deferred.value = !!props.connectionId && !connectionStore.connectedIds.has(props.connectionId);
  if (deferred.value) {
    loading.value = false;
    error.value = "";
    return;
  }
  void load();
}

onMounted(start);
watch(() => [props.pluginId, props.providerId, props.connectionId], start);

defineExpose({
  refresh,
});
</script>

<template>
  <div class="flex size-full min-h-0">
    <PluginRefreshState v-if="deferred" @refresh="void refresh()" />
    <div v-else-if="loading" class="m-auto flex items-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingFilesystem") }}</div>
    <div v-else-if="error || !provider" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error || t("pluginPlatform.filesystemUnavailableFallback") }}</span>
    </div>
    <PluginFileManager v-else ref="fileManagerRef" class="min-h-0 flex-1" :plugin-id="pluginId" :provider="provider" :connection-id="connectionId" :initial-uri="initialUri" />
  </div>
</template>
