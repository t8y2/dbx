<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import {
  PluginHostBridge,
  pluginSandboxDocument,
  PLUGIN_SAVE_CHUNK_BYTES,
  type PluginBridgeTheme,
  type PluginFileHandleMeta,
  type PluginFileReadChunk,
  type PluginFileWriteResult,
  type PluginPickFilesOptions,
  type PluginSaveFileRequest,
  type PluginSaveFileResult,
  type PluginWorkbenchContext,
} from "@/lib/plugins/pluginHostBridge";
import { buildPluginEditorAppearance } from "@/lib/plugins/pluginAppearance";
import { downloadPluginFile, cancelPluginDownload } from "@/lib/plugins/pluginFileDownload";
import type { InstalledPlugin, PluginUiContribution } from "@/types/database";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";

const props = withDefaults(
  defineProps<{
    plugin: InstalledPlugin;
    contribution: PluginUiContribution;
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

// --- Plugin file-transfer bridge (native dialogs + OS file drops) ---------
// The sandboxed iframe cannot reach local files, so handles live here: Tauri
// handles wrap the plugin_file registry in Rust (`t<n>` ids); the web host
// keeps File objects and in-memory save buffers (`w<n>` ids). Only paths that
// came from a native dialog or an OS drop reach plugin_file_open — never a
// plugin-supplied string.

let webFileSequence = 0;
const webPickedFiles = new Map<string, File>();
const webSaveBuffers = new Map<string, { name: string; contentType: string; chunks: Map<number, Uint8Array> }>();
const openTauriHandles = new Set<number>();
const tauriHandlePrefix = "t";
const webHandlePrefix = "w";

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function parseHandleId(handleId: string): { source: "tauri" | "web"; numericId: number } {
  if (handleId.startsWith(tauriHandlePrefix)) return { source: "tauri", numericId: Number(handleId.slice(tauriHandlePrefix.length)) };
  if (handleId.startsWith(webHandlePrefix)) return { source: "web", numericId: Number(handleId.slice(webHandlePrefix.length)) };
  throw new Error("Unknown file handle");
}

/** Loaded lazily: the static tauri module drags side-effectful imports (i18n boot)
 *  into specs that mock the whole backend layer. */
async function tauriFileApi() {
  return import("@/lib/backend/tauri");
}

async function openTauriPluginFile(pluginId: string, path: string, write: boolean): Promise<PluginFileHandleMeta> {
  const { openPluginLocalFile } = await tauriFileApi();
  const handle = await openPluginLocalFile(pluginId, path, write);
  // Track read AND write handles: unmount must reclaim both (leaked fds also
  // burn the shared 64-handle registry quota).
  openTauriHandles.add(handle.handleId);
  return { handleId: `${tauriHandlePrefix}${handle.handleId}`, name: handle.name, size: handle.size, contentType: handle.contentType };
}

async function pickPluginFiles(pluginId: string, options: PluginPickFilesOptions): Promise<PluginFileHandleMeta[]> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: options.multiple === true });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const files: PluginFileHandleMeta[] = [];
    for (const path of paths) {
      try {
        files.push(await openTauriPluginFile(pluginId, path, false));
      } catch (error) {
        console.warn("[DBX][plugin-workbench:pick]", error);
      }
    }
    return files;
  }
  // Web host: a top-document file input still works there (no sandbox).
  const selection = await new Promise<FileList | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple === true;
    input.style.display = "none";
    // The picker fires no change event on cancel; without this the pick
    // promise hangs forever and the plugin's upload waits on nothing.
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.addEventListener("change", () => {
      input.remove();
      resolve(input.files);
    });
    document.body.appendChild(input);
    input.click();
  });
  const files: PluginFileHandleMeta[] = [];
  for (const file of Array.from(selection || [])) {
    const handleId = `${webHandlePrefix}${++webFileSequence}`;
    webPickedFiles.set(handleId, file);
    files.push({ handleId, name: file.name, size: file.size, contentType: file.type || "application/octet-stream" });
  }
  return files;
}

async function readPluginFileChunkById(pluginId: string, handleId: string, offset: number, length?: number): Promise<PluginFileReadChunk> {
  const parsed = parseHandleId(handleId);
  if (parsed.source === "tauri") {
    const { readPluginLocalFileChunk } = await tauriFileApi();
    return readPluginLocalFileChunk(pluginId, parsed.numericId, offset, length);
  }
  const file = webPickedFiles.get(handleId);
  if (!file) throw new Error("Unknown file handle");
  const slice = file.slice(offset, offset + (length ?? PLUGIN_SAVE_CHUNK_BYTES));
  const bytes = new Uint8Array(await slice.arrayBuffer());
  return { dataBase64: encodeBytesBase64(bytes), length: bytes.byteLength, eof: offset + bytes.byteLength >= file.size };
}

// --- Plugin UI storage bridge ---------------------------------------------
// Native hosts persist to `plugin-data/<id>/ui-storage.json` through Rust; the
// web host has no plugin-data tree, so entries fall back to the top document's
// localStorage under a per-plugin prefix (same isolation, same JSON values).

function webStorageKey(pluginId: string, key: string): string {
  return `dbx-plugin-storage:${pluginId}:${key}`;
}

async function getPluginStorage(pluginId: string, key: string): Promise<unknown> {
  if (isTauriRuntime()) {
    const { getPluginUiStorage } = await tauriFileApi();
    return getPluginUiStorage(pluginId, key);
  }
  const raw = localStorage.getItem(webStorageKey(pluginId, key));
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

async function setPluginStorage(pluginId: string, key: string, value: unknown): Promise<void> {
  if (isTauriRuntime()) {
    const { setPluginUiStorage } = await tauriFileApi();
    return setPluginUiStorage(pluginId, key, value);
  }
  localStorage.setItem(webStorageKey(pluginId, key), JSON.stringify(value === undefined ? null : value));
}

async function deletePluginStorage(pluginId: string, key: string): Promise<void> {
  if (isTauriRuntime()) {
    const { deletePluginUiStorage } = await tauriFileApi();
    return deletePluginUiStorage(pluginId, key);
  }
  localStorage.removeItem(webStorageKey(pluginId, key));
}

async function beginPluginFileSave(pluginId: string, request: { name?: string; contentType?: string; size?: number }): Promise<{ handleId: string; chunkBytes: number } | null> {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const fileName = request.name || "download.bin";
    const extension = fileName.includes(".") ? fileName.split(".").pop() : "";
    const path = await save({
      defaultPath: fileName,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
    });
    if (!path) return null;
    // Route through openTauriPluginFile so the write handle joins
    // openTauriHandles: a beginSave the plugin abandons must still be
    // reclaimed on unmount instead of burning the shared registry quota.
    const handle = await openTauriPluginFile(pluginId, path, true);
    return { handleId: handle.handleId, chunkBytes: PLUGIN_SAVE_CHUNK_BYTES };
  }
  const handleId = `${webHandlePrefix}${++webFileSequence}`;
  webSaveBuffers.set(handleId, { name: request.name || "download.bin", contentType: request.contentType || "application/octet-stream", chunks: new Map() });
  return { handleId, chunkBytes: PLUGIN_SAVE_CHUNK_BYTES };
}

async function writePluginFileChunkById(pluginId: string, handleId: string, offset: number, bytes: Uint8Array): Promise<PluginFileWriteResult> {
  const parsed = parseHandleId(handleId);
  if (parsed.source === "tauri") {
    const { writePluginLocalFileChunk } = await tauriFileApi();
    return writePluginLocalFileChunk(pluginId, parsed.numericId, offset, encodeBytesBase64(bytes));
  }
  const buffer = webSaveBuffers.get(handleId);
  if (!buffer) throw new Error("Unknown file handle");
  buffer.chunks.set(offset, bytes);
  return { written: bytes.byteLength, nextOffset: offset + bytes.byteLength };
}

async function finishPluginFileSave(pluginId: string, handleId: string): Promise<void> {
  const parsed = parseHandleId(handleId);
  if (parsed.source === "tauri") {
    const { closePluginLocalFile } = await tauriFileApi();
    openTauriHandles.delete(parsed.numericId);
    await closePluginLocalFile(pluginId, parsed.numericId);
    return;
  }
  const buffer = webSaveBuffers.get(handleId);
  if (!buffer) throw new Error("Unknown file handle");
  webSaveBuffers.delete(handleId);
  const ordered = [...buffer.chunks.entries()].sort(([left], [right]) => left - right);
  const size = ordered.reduce((total, [, chunk]) => total + chunk.byteLength, 0);
  const assembled = new Uint8Array(size);
  let cursor = 0;
  for (const [, chunk] of ordered) {
    assembled.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  const url = URL.createObjectURL(new Blob([assembled.buffer as ArrayBuffer], { type: buffer.contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buffer.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function closePluginFileHandleById(pluginId: string, handleId: string): Promise<void> {
  const parsed = parseHandleId(handleId);
  if (parsed.source === "tauri") {
    const { closePluginLocalFile } = await tauriFileApi();
    openTauriHandles.delete(parsed.numericId);
    await closePluginLocalFile(pluginId, parsed.numericId);
    return;
  }
  webPickedFiles.delete(handleId);
  webSaveBuffers.delete(handleId);
}

function disposeLocalFileHandles(): void {
  for (const handleId of openTauriHandles)
    tauriFileApi()
      .then(({ closePluginLocalFile }) => closePluginLocalFile(props.plugin.manifest.id, handleId))
      .catch(() => undefined);
  openTauriHandles.clear();
  webPickedFiles.clear();
  webSaveBuffers.clear();
}

// --- OS file-drop routing (Tauri captures drops at the webview layer) -----
// Tauri's native drag-drop pipeline hands file PATHS to the host page; HTML5
// drop events with real files never reach web content, and plugin iframes
// especially. The webview-level `dbx:tauri-file-drop` event (see useFileDrop)
// carries the physical-window position, so the workbench claims drops whose
// converted CSS point lands on its iframe: preventDefault stops the host's
// open-as-database fallback, and the paths are opened into handles that the
// plugin receives through the bridge.

interface TauriFileDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}

let dropDragActive = false;

function forwardDragState(active: boolean): void {
  dropDragActive = active;
  bridge?.forwardDragState(active);
}

function onHostFileDrop(event: Event): void {
  const payload = (event as CustomEvent<TauriFileDropPayload>).detail;
  if (!payload || payload.type === "leave") {
    if (dropDragActive) forwardDragState(false);
    return;
  }
  const frame = iframe.value;
  const position = payload.position;
  if (!frame || !position) {
    if (dropDragActive) forwardDragState(false);
    return;
  }
  // Overlay titlebar: the webview starts at the window origin, so physical
  // window coordinates divide straight into CSS pixels via devicePixelRatio.
  const scale = window.devicePixelRatio || 1;
  if (document.elementFromPoint(position.x / scale, position.y / scale) !== frame) {
    if (dropDragActive) forwardDragState(false);
    return;
  }
  // Claim the drop so the host fallback (open as SQL/database) does not run.
  event.preventDefault();
  if (payload.type !== "drop") {
    if (!dropDragActive) forwardDragState(true);
    return;
  }
  forwardDragState(false);
  const paths = (payload.paths || []).filter((path) => typeof path === "string" && path);
  if (!paths.length || !bridge) return;
  void (async () => {
    const files: PluginFileHandleMeta[] = [];
    for (const path of paths) {
      try {
        files.push(await openTauriPluginFile(props.plugin.manifest.id, path, false));
      } catch (error) {
        console.error("[DBX][plugin-workbench:drop]", error);
      }
    }
    if (files.length) bridge?.forwardFileDrop(files);
  })();
}

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
  return {
    appearance: isDark.value ? "dark" : "light",
    tokens,
    editor: buildPluginEditorAppearance(settingsStore.editorSettings),
  };
}

function createBridge() {
  bridge?.dispose();
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
      // Both plan calls carry the plugin's declared `host.plans:read` gate in the
      // bridge; the backend owns EXPLAIN generation, the timeout, and the plan cap.
      getPlanCapabilities: (connectionId) => api.getPluginPlanCapabilities(connectionId),
      explainPlan: (request) => api.getPluginEstimatedPlan(request),
      closeTab: () => emit("closeTab"),
      saveFile: (_pluginId, request, data) => savePluginFile(request, data),
      downloadFile: isTauriRuntime() ? downloadPluginFile : undefined,
      cancelDownload: isTauriRuntime() ? cancelPluginDownload : undefined,
      copyText: (_pluginId, text) => copyToClipboard(text),
      pickFiles: (pluginId, options) => pickPluginFiles(pluginId, options),
      readFileChunk: (pluginId, handleId, offset, length) => readPluginFileChunkById(pluginId, handleId, offset, length),
      beginFileSave: (pluginId, request) => beginPluginFileSave(pluginId, request),
      writeFileChunk: (pluginId, handleId, offset, bytes) => writePluginFileChunkById(pluginId, handleId, offset, bytes),
      finishFileSave: (pluginId, handleId) => finishPluginFileSave(pluginId, handleId),
      closeFileHandle: (pluginId, handleId) => closePluginFileHandleById(pluginId, handleId),
      storageGet: (pluginId, key) => getPluginStorage(pluginId, key),
      storageSet: (pluginId, key, value) => setPluginStorage(pluginId, key, value),
      storageDelete: (pluginId, key) => deletePluginStorage(pluginId, key),
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

async function inlineLocalUiAssets(html: string, pluginId: string): Promise<{ html: string; entryDirectory: string }> {
  const document = new DOMParser().parseFromString(html, "text/html");
  const resources = [...document.querySelectorAll("script[src], link[rel='stylesheet'][href]")];
  // Dynamic-import chunks and CSS url() references live next to the entry
  // script; its directory is the <base> the sandbox document needs to resolve
  // them through the dbx-plugin scheme.
  let entryDirectory = "";
  for (const resource of resources) {
    const source = resource.getAttribute(resource.tagName === "SCRIPT" ? "src" : "href");
    const path = source ? localUiAssetPath(source) : undefined;
    if (!path) continue;
    if (!entryDirectory) entryDirectory = path.split("/").slice(0, -1).join("/");
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
  return { html: document.documentElement.outerHTML, entryDirectory };
}

/**
 * Base URL prefix for lazy-loaded plugin UI assets. wry serves custom schemes
 * natively on WKWebView/webkit2gtk but maps them onto http(s) subdomains on
 * WebView2, so the host page's own protocol picks the form the webview will
 * actually request. The web host has no plugin asset protocol.
 */
function pluginUiBaseUrl(pluginId: string, entryDirectory: string): string | undefined {
  if (!isTauriRuntime()) return undefined;
  const origin = location.protocol === "http:" || location.protocol === "https:" ? `${location.protocol}//dbx-plugin.localhost/${pluginId}/` : `dbx-plugin://localhost/${pluginId}/`;
  return entryDirectory ? `${origin}${entryDirectory}/` : origin;
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
    const { html, entryDirectory } = await inlineLocalUiAssets(new TextDecoder().decode(bytes), props.plugin.manifest.id);
    if (disposed || generation !== loadGeneration) return;
    source.value = pluginSandboxDocument(html, props.plugin.manifest.permissions, currentBridgeTheme(), {
      baseUrl: pluginUiBaseUrl(props.plugin.manifest.id, entryDirectory),
    });
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
  document.addEventListener("dbx:tauri-file-drop", onHostFileDrop);
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
// Font families are mirrored onto root tokens by App.vue (writeRootToken) and
// reach live bridges through the themeRevision bump above. fontSize and the
// SQL editor syntax theme have no CSS-token carrier — watch them explicitly.
watch(
  () => [settingsStore.editorSettings.fontSize, settingsStore.editorSettings.theme],
  () => bridge?.updateTheme(currentBridgeTheme()),
);

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  bridge?.dispose();
  bridge = undefined;
  window.removeEventListener("message", onMessage);
  document.removeEventListener("dbx:tauri-file-drop", onHostFileDrop);
  disposeLocalFileHandles();
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
