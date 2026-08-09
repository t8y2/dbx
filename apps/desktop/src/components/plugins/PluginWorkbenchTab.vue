<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import type { PluginWorkbenchContext } from "@/lib/plugins/pluginHostBridge";
import type { InstalledPlugin } from "@/types/database";
import { useQueryStore } from "@/stores/queryStore";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  pluginId: string;
  contributionId: string;
  context?: PluginWorkbenchContext;
}>();

const { t, locale: appLocale } = useI18n();
const queryStore = useQueryStore();
const plugins = ref<InstalledPlugin[]>([]);
const loading = ref(true);
const error = ref("");
let loadGeneration = 0;
const entry = computed(() => createFrontendPluginRegistry(plugins.value, appLocale.value).findWorkbench(props.pluginId, props.contributionId));

async function load() {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = "";
  try {
    const installed = await api.listPlugins();
    if (generation !== loadGeneration) return;
    plugins.value = installed;
    if (!entry.value) throw new Error(t("pluginPlatform.workbenchUnavailable", { pluginId: props.pluginId, contributionId: props.contributionId }));
  } catch (cause) {
    if (generation !== loadGeneration) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function openWorkbench(pluginId: string, contributionId: string, context?: PluginWorkbenchContext) {
  const target = createFrontendPluginRegistry(plugins.value, appLocale.value).findWorkbench(pluginId, contributionId);
  queryStore.openPluginWorkbench(pluginId, contributionId, { title: target?.contribution.label || contributionId, context });
}

function openFilesystem(pluginId: string, providerId: string, context?: PluginWorkbenchContext) {
  const target = createFrontendPluginRegistry(plugins.value, appLocale.value)
    .listFilesystemProviders()
    .find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === providerId);
  if (!target) throw new Error(t("pluginPlatform.filesystemUnavailable", { pluginId, providerId }));
  queryStore.openPluginFilesystem(pluginId, providerId, {
    title: target.contribution.label,
    connectionId: typeof context?.connectionId === "string" ? context.connectionId : undefined,
    rootUri: target.contribution.root_uri,
    currentUri: typeof context?.uri === "string" ? context.uri : undefined,
  });
}

onMounted(() => void load());
watch(
  () => [props.pluginId, props.contributionId],
  () => void load(),
);
</script>

<template>
  <div class="flex size-full min-h-0">
    <div v-if="loading" class="m-auto flex items-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingWorkbench") }}</div>
    <div v-else-if="error || !entry" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error || t("pluginPlatform.workbenchUnavailableFallback") }}</span>
    </div>
    <PluginWorkbenchHost v-else class="min-h-0 flex-1" :plugin="entry.plugin" :contribution="entry.contribution" :context="context" @open-workbench="openWorkbench" @open-filesystem="openFilesystem" />
  </div>
</template>
