<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import { PluginHostBridge, pluginSandboxDocument, type PluginBridgeTheme, type PluginSaveFileRequest, type PluginSaveFileResult, type PluginWorkbenchContext } from "@/lib/plugins/pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";

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
  openWorkbench: [pluginId: string, contributionId: string, context?: PluginWorkbenchContext, options?: { forceNew?: boolean }];
  openFilesystem: [pluginId: string, providerId: string, context?: PluginWorkbenchContext];
  closeTab: [];
}>();

const { t, locale: appLocale } = useI18n();
const { isDark, themeRevision } = useTheme();
const settingsStore = useSettingsStore();
const iframe = ref<HTMLIFrameElement>();
const source = ref("");
const loading = ref(true);
// Stays false until the iframe's load event: WKWebView paints a white canvas
// for a freshly inserted iframe before the sandbox document's first styled
// frame, so the themed overlay must keep covering the frame area until then.
const frameReady = ref(false);
const error = ref("");
let bridge: PluginHostBridge | undefined;
let unsubscribeEvents: (() => void) | undefined;
let disposed = false;
let loadGeneration = 0;

const title = computed(() => `${props.plugin.manifest.name} · ${props.contribution.label}`);

/** Collect resolved DBX design tokens so the sandbox can theme itself with the same values. */
function currentBridgeTheme(): PluginBridgeTheme {
  const tokens: Record<string, string> = {};
  if (typeof document !== "undefined") {
    const style = getComputedStyle(document.documentElement);
    for (const name of style) {
      if (!name.startsWith("--") || name.startsWith("--dbx-")) continue;
      if (/^--(color|radius|font)/.test(name)) {
        const value = style.getPropertyValue(name).trim();
        if (value) tokens[name] = value;
      }
    }
  }
  return { appearance: isDark.value ? "dark" : "light", tokens };
}

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
      openWorkbench: async (pluginId, contributionId, context, options) => emit("openWorkbench", pluginId, contributionId, context, options),
      openFilesystem: async (pluginId, providerId, context) => emit("openFilesystem", pluginId, providerId, context),
      reopenConnection: (pluginId, connectionId) => useConnectionStore().reopenPluginConnection(connectionId, pluginId),
      closeTab: () => emit("closeTab"),
      saveFile: (_pluginId, request, data) => savePluginFile(request, data),
      copyText: (_pluginId, text) => copyToClipboard(text),
    },
    appLocale.value,
    currentBridgeTheme(),
  );
  // An iframe reload (F5 / webview restart) drops the plugin sidecar's
  // in-memory connection registry while the host still holds the connection
  // open. Re-push the connection config through the same path as a sidebar
  // open before the plugin receives its fresh init, so it can reconnect
  // without the user reopening the connection from the sidebar.
  bridge.onReinit = async () => {
    const connectionId = props.context?.connectionId;
    if (!connectionId) return;
    await useConnectionStore().repushPluginConnection(connectionId);
  };
}

/** Keep a plugin-supplied name from smuggling path separators or traversal into the save dialog. */
function safeFileName(value: string | undefined): string {
  const base = (value || "").split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]+/g, "").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download.bin";
}

/**
 * Native save dialog + disk write for plugin downloads. The sandboxed iframe
 * cannot trigger downloads itself (WKWebView cancels blob-anchor navigations
 * when no host download handler is registered), so the bytes travel through
 * the bridge and the host persists them. Resolves null when the user cancels.
 */
async function savePluginFile(request: PluginSaveFileRequest, data: Uint8Array): Promise<PluginSaveFileResult | null> {
  const fileName = safeFileName(request.fileName);
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const extension = fileName.includes(".") ? (fileName.split(".").pop() as string) : "";
    const path = await save({
      defaultPath: fileName,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
    });
    if (!path) return null;
    await writeFile(path, data);
    return { path };
  }
  // Web host: the sandboxed iframe cannot download, but the host page can.
  // Transferred buffers are plain ArrayBuffers (SharedArrayBuffer cannot cross postMessage).
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: request.contentType || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { path: fileName };
}

function localUiAssetPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || /^(?:blob:|data:|https?:|\/\/)/i.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, "https://dbx-plugin.invalid/");
    if (resolved.origin !== "https://dbx-plugin.invalid") return undefined;
    const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
    if (!path || path.split("/").some((segment) => segment === "..")) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

async function inlineLocalUiAssets(html: string, pluginId: string): Promise<string> {
  const document = new DOMParser().parseFromString(html, "text/html");
  const resources = [...document.querySelectorAll("script[src], link[rel='stylesheet'][href]")];
  for (const resource of resources) {
    const source = resource.getAttribute(resource.tagName === "SCRIPT" ? "src" : "href");
    const path = source ? localUiAssetPath(source) : undefined;
    if (!path) continue;
    const asset = await api.readPluginUiAsset(pluginId, path);
    const content = new TextDecoder().decode(Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0)));
    if (resource.tagName === "SCRIPT") {
      const script = document.createElement("script");
      for (const attribute of [...resource.attributes]) {
        if (attribute.name !== "src") script.setAttribute(attribute.name, attribute.value);
      }
      script.textContent = content;
      resource.replaceWith(script);
    } else {
      const style = document.createElement("style");
      style.textContent = content;
      resource.replaceWith(style);
    }
  }
  return document.documentElement.outerHTML;
}

async function loadWorkbench() {
  const generation = ++loadGeneration;
  bridge?.dispose();
  bridge = undefined;
  loading.value = true;
  frameReady.value = false;
  error.value = "";
  try {
    if (!props.plugin.compatibility.compatible) throw new Error((props.plugin.compatibility.errors || []).join("; ") || t("pluginPlatform.pluginIncompatible"));
    const asset = await api.readPluginUiEntry(props.plugin.manifest.id);
    if (disposed || generation !== loadGeneration) return;
    const bytes = Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0));
    const html = await inlineLocalUiAssets(new TextDecoder().decode(bytes), props.plugin.manifest.id);
    if (disposed || generation !== loadGeneration) return;
    source.value = pluginSandboxDocument(html, props.plugin.manifest.permissions, currentBridgeTheme());
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
  // The load event can precede the webview's first actual paint (notably on
  // WKWebView); reveal after two animation frames, with a timer fallback
  // because rAF stalls in occluded/background webviews. Guarded by generation
  // so a stale callback from a rebuilt iframe can't lift the new overlay.
  const generation = loadGeneration;
  const reveal = () => {
    if (!disposed && generation === loadGeneration) frameReady.value = true;
  };
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 400);
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

// Identity changes require rebuilding the sandbox document; context and locale
// changes are pushed through the bridge so plugin UI state survives them.
watch(
  () => [props.plugin.manifest.id, props.plugin.manifest.version, props.contribution.id] as const,
  () => void loadWorkbench(),
);
watch(
  () => props.context,
  (context) => bridge?.updateContext(context ?? {}),
  { deep: true },
);
watch(appLocale, (locale) => bridge?.updateLocale(locale));
// Keyed on the theme revision (bumped by applyTheme) so every theme change
// path — dark/light, palette switch, custom colors — re-pushes the resolved
// tokens; watching isDark/custom colors alone misses palette-only switches.
watch(themeRevision, () => bridge?.updateTheme(currentBridgeTheme()));
// Font settings are applied outside applyTheme() (see App.vue applyUiFontFamily)
// and therefore never bump themeRevision; watch them explicitly so font token
// changes reach live plugin bridges without waiting for the next theme switch.
watch(
  () => [settingsStore.editorSettings.uiFontFamily, settingsStore.editorSettings.fontFamily, settingsStore.editorSettings.fontSize],
  () => bridge?.updateTheme(currentBridgeTheme()),
);

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  bridge?.dispose();
  bridge = undefined;
  window.removeEventListener("message", onMessage);
  unsubscribeEvents?.();
});
</script>

<template>
  <div class="relative flex size-full min-h-40 overflow-hidden bg-background">
    <div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
      <Loader2 class="mr-2 size-4 animate-spin" />
      {{ t("pluginPlatform.loadingTitle", { title }) }}
    </div>
    <div v-else-if="error" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error }}</span>
    </div>
    <template v-else>
      <iframe ref="iframe" :title="title" :srcdoc="source" sandbox="allow-scripts" allow="clipboard-write" referrerpolicy="no-referrer" class="size-full border-0 bg-transparent" @load="onFrameLoad" />
      <!-- Cover until the frame has actually painted: the iframe stays mounted
           underneath so its load event can fire (v-else on the overlay would
           deadlock), it just isn't visible yet. Fully opaque so the covered
           phase is visually identical to the host background, and faded out
           instead of removed so the reveal is never a hard swap. -->
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground transition-opacity duration-150 ease-out" :class="frameReady ? 'pointer-events-none opacity-0' : 'opacity-100'">
        <Loader2 class="mr-2 size-4 animate-spin" />
        {{ t("pluginPlatform.loadingTitle", { title }) }}
      </div>
    </template>
  </div>
</template>
