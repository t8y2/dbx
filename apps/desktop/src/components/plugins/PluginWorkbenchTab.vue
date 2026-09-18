<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import PluginRefreshState from "@/components/plugins/PluginRefreshState.vue";
import * as api from "@/lib/backend/api";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import type { PluginWorkbenchContext } from "@/lib/plugins/pluginHostBridge";
import type { InstalledPlugin } from "@/types/database";
import { useQueryStore } from "@/stores/queryStore";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{
  pluginId: string;
  contributionId: string;
  connectionId?: string;
  context?: PluginWorkbenchContext;
}>();

const { t, locale: appLocale } = useI18n();
const emit = defineEmits<{
  closeTab: [];
}>();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const plugins = ref<InstalledPlugin[]>([]);
const loading = ref(true);
const error = ref("");
const deferred = ref(false);
let loadGeneration = 0;
const resolvedConnectionId = computed(() => props.connectionId || (typeof props.context?.connectionId === "string" ? props.context.connectionId : undefined));
// The host's re-push-on-reinit and the plugin itself both key off
// context.connectionId; filesystem tabs carry it only as a tab-level prop.
const hostContext = computed(() => {
  if (!resolvedConnectionId.value || props.context?.connectionId) return props.context;
  return { ...props.context, connectionId: resolvedConnectionId.value };
});
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

async function refresh() {
  deferred.value = false;
  loading.value = true;
  error.value = "";
  try {
    const connectionId = resolvedConnectionId.value;
    if (connectionId) {
      if (connectionStore.connectedIds.has(connectionId)) {
        // The connection is open but the plugin sidecar's registry may have
        // been wiped (iframe reload, tab restore): ensureConnected's health
        // fast-path only probes the sidecar process and would not heal that.
        // Force a re-push instead; it no-ops when a push just happened.
        await connectionStore.repushPluginConnection(connectionId);
      } else {
        await connectionStore.ensureConnected(connectionId);
      }
    }
    await load();
  } catch (cause) {
    loading.value = false;
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function start() {
  const connectionId = resolvedConnectionId.value;
  deferred.value = !!connectionId && !connectionStore.connectedIds.has(connectionId);
  if (deferred.value) {
    loading.value = false;
    error.value = "";
    return;
  }
  void load();
}

function openWorkbench(pluginId: string, contributionId: string, context?: PluginWorkbenchContext, options?: { forceNew?: boolean }) {
  const target = createFrontendPluginRegistry(plugins.value, appLocale.value).findWorkbench(pluginId, contributionId);
  // Session tabs are per-connection: title them after the connection (like the
  // sidebar-opened tab) so parallel sessions read "server", "server (2)", …
  // — the numbering itself is applied in queryStore.openPluginWorkbench.
  const contextConnectionId = typeof context?.connectionId === "string" ? context.connectionId : "";
  const connectionName = contextConnectionId ? connectionStore.getConfig(contextConnectionId)?.name : undefined;
  queryStore.openPluginWorkbench(pluginId, contributionId, { title: connectionName || target?.contribution.label || contributionId, context, forceNew: options?.forceNew === true });
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

onMounted(start);
watch(() => [props.pluginId, props.contributionId, props.connectionId, props.context?.connectionId], start);

defineExpose({ refresh });
</script>

<template>
  <div class="flex size-full min-h-0">
    <PluginRefreshState v-if="deferred" @refresh="void refresh()" />
    <div v-else-if="loading" class="m-auto flex items-center text-sm text-muted-foreground"><Loader2 class="mr-2 size-4 animate-spin" />{{ t("pluginPlatform.loadingWorkbench") }}</div>
    <div v-else-if="error || !entry" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error || t("pluginPlatform.workbenchUnavailableFallback") }}</span>
    </div>
    <PluginWorkbenchHost v-else class="min-h-0 flex-1" :plugin="entry.plugin" :contribution="entry.contribution" :context="hostContext" @open-workbench="openWorkbench" @open-filesystem="openFilesystem" @close-tab="emit('closeTab')" />
  </div>
</template>
