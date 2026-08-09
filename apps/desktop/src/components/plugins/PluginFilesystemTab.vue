<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import PluginFileManager from "@/components/plugins/PluginFileManager.vue";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import type { InstalledPlugin } from "@/types/database";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  pluginId: string;
  providerId: string;
  connectionId?: string;
  rootUri?: string;
  initialUri?: string;
}>();

const { t, locale: appLocale } = useI18n();

const plugins = ref<InstalledPlugin[]>([]);
const loading = ref(true);
const error = ref("");
let loadGeneration = 0;
const entry = computed(() =>
  createFrontendPluginRegistry(plugins.value, appLocale.value)
    .listFilesystemProviders()
    .find((candidate) => candidate.plugin.manifest.id === props.pluginId && candidate.contribution.id === props.providerId),
);
const provider = computed(() => (entry.value ? { ...entry.value.contribution, root_uri: props.rootUri || entry.value.contribution.root_uri } : undefined));

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

onMounted(() => void load());
watch(
  () => [props.pluginId, props.providerId],
  () => void load(),
);
</script>

<template>
  <div class="flex size-full min-h-0">
    <div v-if="loading" class="m-auto flex items-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingFilesystem") }}</div>
    <div v-else-if="error || !provider" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error || t("pluginPlatform.filesystemUnavailableFallback") }}</span>
    </div>
    <PluginFileManager v-else class="min-h-0 flex-1" :plugin-id="pluginId" :provider="provider" :connection-id="connectionId" :initial-uri="initialUri" />
  </div>
</template>
