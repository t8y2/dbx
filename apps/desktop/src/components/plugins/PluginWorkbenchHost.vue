<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { PluginHostBridge, pluginSandboxDocument, type PluginWorkbenchContext } from "@/lib/plugins/pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    plugin: InstalledPlugin;
    contribution: PluginWorkbenchContribution;
    context?: PluginWorkbenchContext;
  }>(),
  { context: () => ({}) },
);

const emit = defineEmits<{
  ready: [];
  error: [message: string];
  openWorkbench: [pluginId: string, contributionId: string, context?: PluginWorkbenchContext];
  openFilesystem: [pluginId: string, providerId: string, context?: PluginWorkbenchContext];
}>();

const { t, locale: appLocale } = useI18n();
const iframe = ref<HTMLIFrameElement>();
const source = ref("");
const loading = ref(true);
const error = ref("");
let bridge: PluginHostBridge | undefined;
let unsubscribeEvents: (() => void) | undefined;
let disposed = false;
let loadGeneration = 0;

const title = computed(() => `${props.plugin.manifest.name} · ${props.contribution.label}`);

function createBridge() {
  bridge = new PluginHostBridge(
    props.plugin,
    props.contribution,
    props.context,
    () => iframe.value?.contentWindow || null,
    {
      invoke: api.invokePlugin,
      notify: api.notifyPlugin,
      sendBinary: api.sendPluginBinary,
      readAsset: api.readPluginUiAsset,
      openWorkbench: async (pluginId, contributionId, context) => emit("openWorkbench", pluginId, contributionId, context),
      openFilesystem: async (pluginId, providerId, context) => emit("openFilesystem", pluginId, providerId, context),
    },
    appLocale.value,
  );
}

async function loadWorkbench() {
  const generation = ++loadGeneration;
  bridge = undefined;
  loading.value = true;
  error.value = "";
  try {
    if (!props.plugin.compatibility.compatible) throw new Error((props.plugin.compatibility.errors || []).join("; ") || t("pluginPlatform.pluginIncompatible"));
    const asset = await api.readPluginUiEntry(props.plugin.manifest.id);
    if (disposed || generation !== loadGeneration) return;
    const bytes = Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0));
    source.value = pluginSandboxDocument(new TextDecoder().decode(bytes));
    await nextTick();
    if (disposed || generation !== loadGeneration) return;
    createBridge();
  } catch (cause) {
    if (disposed || generation !== loadGeneration) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    emit("error", error.value);
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false;
  }
}

function onMessage(event: MessageEvent) {
  bridge?.handleWindowMessage(event);
}

function onFrameLoad() {
  bridge?.sendInit();
  emit("ready");
}

onMounted(async () => {
  window.addEventListener("message", onMessage);
  const unsubscribe = await api.subscribePluginEvents(
    (event) => bridge?.forwardEvent(event),
    (event) => bridge?.forwardBinary(event),
  );
  if (disposed) {
    unsubscribe();
    return;
  }
  unsubscribeEvents = unsubscribe;
  await loadWorkbench();
});

watch(
  () => [props.plugin.manifest.id, props.plugin.manifest.version, props.contribution.id, props.context, appLocale.value] as const,
  () => void loadWorkbench(),
  { deep: true },
);

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  bridge = undefined;
  window.removeEventListener("message", onMessage);
  unsubscribeEvents?.();
});
</script>

<template>
  <div class="relative flex size-full min-h-40 overflow-hidden bg-background">
    <div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-background/80 text-sm text-muted-foreground backdrop-blur-sm">
      <Loader2 class="mr-2 size-4 animate-spin" />
      {{ t("pluginPlatform.loadingTitle", { title }) }}
    </div>
    <div v-else-if="error" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error }}</span>
    </div>
    <iframe v-else ref="iframe" :title="title" :srcdoc="source" sandbox="allow-scripts" referrerpolicy="no-referrer" class="size-full border-0 bg-transparent" @load="onFrameLoad" />
  </div>
</template>
