<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard, readImageFromClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
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
  type PluginAiRecommendationHostUpdate,
} from "@/lib/plugins/pluginHostBridge";
import { getCachedPluginUiHtml, getOrLoadPluginUiHtml } from "@/lib/plugins/pluginUiHtmlCache";
import { beginFloatingWindowDrag, closeFloatingWindows, endFloatingWindowDrag, openFloatingWindow, setFloatingWindowSize } from "@/lib/plugins/pluginFloatingWindow";
import { isFloatingPluginWindow } from "@/lib/app/windowContext";
import { buildPluginEditorAppearance } from "@/lib/plugins/pluginAppearance";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import { downloadPluginFile, cancelPluginDownload } from "@/lib/plugins/pluginFileDownload";
import type { InstalledPlugin, PluginUiContribution } from "@/types/database";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { createPluginAiCompletion, type PluginAiConfirmDecision, type PluginAiPromptPreview } from "@/lib/plugins/pluginAiCompletion";
import { useQueryStore } from "@/stores/queryStore";
import { OPEN_PLUGIN_AI_CONVERSATION } from "@/lib/ai/aiPluginConversation";

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
  recommendations: [update: PluginAiRecommendationHostUpdate];
}>();

const { t, locale: appLocale } = useI18n();
const { isDark, themeRevision } = useTheme();
const settingsStore = useSettingsStore();
const openAiConversation = inject(OPEN_PLUGIN_AI_CONVERSATION, undefined);

// --- Plugin AI generation consent (E2) --------------------------------------
// Every host.ai.generateText send is consented through this in-app dialog: it
// names the destination model, previews the outgoing text (first line, byte
// size, workbench context) and offers a workbench-session "don't ask again"
// memory. The memory itself lives inside the aiCompletion instance (in-memory
// only, never persisted) — the checkbox here just reports the user's choice.
interface PluginAiConfirmDialogState {
  title: string;
  message: string;
  preview: PluginAiPromptPreview;
  previewHeading: string;
  sizeLabel: string;
  contextLabel: string;
  rememberLabel: string;
  continueLabel: string;
  cancelLabel: string;
}
const aiConfirmDialog = ref<PluginAiConfirmDialogState | null>(null);
const aiConfirmRemember = ref(false);
let aiConfirmResolve: ((decision: PluginAiConfirmDecision) => void) | undefined;

function formatPluginAiContextLabel(): string {
  const zh = appLocale.value.startsWith("zh");
  const parts: string[] = [];
  const connectionId = typeof props.context?.connectionId === "string" ? props.context.connectionId : "";
  if (connectionId) {
    const connectionName = useConnectionStore().getConfig(connectionId)?.name || connectionId;
    parts.push(`${zh ? "连接" : "Connection"}: ${connectionName}`);
  }
  for (const key of ["database", "schema"] as const) {
    const value = props.context?.[key];
    if (typeof value === "string" && value.trim()) parts.push(`${zh ? (key === "database" ? "数据库" : "模式") : key === "database" ? "Database" : "Schema"}: ${value.trim()}`);
  }
  return parts.join(" · ");
}

function resolveAiGenerationConfirm(allowed: boolean): void {
  const resolve = aiConfirmResolve;
  aiConfirmResolve = undefined;
  const remember = aiConfirmRemember.value;
  aiConfirmDialog.value = null;
  aiConfirmRemember.value = false;
  // A denial is never remembered: the plugin may legitimately retry, and the
  // memory option only takes effect together with an explicit allow.
  resolve?.(allowed ? { allowed: true, remember } : false);
}

const aiCompletion = createPluginAiCompletion({
  load: () => import("@/lib/backend/tauri").then((api) => api.loadAiConfigs()),
  discover: (config) => import("@/lib/backend/tauri").then((api) => api.aiListModels(config)),
  complete: (request) => import("@/lib/backend/tauri").then((api) => api.aiComplete(request)),
  // E1: ride the desktop streaming pipeline (ai_stream + per-session cancel
  // registry). Only wired here, so the bridge advertises aiCompletionStream
  // on desktop hosts and leaves it off elsewhere.
  stream: async (sessionId, request, onChunk) => {
    const { aiStream } = await tauriFileApi();
    await aiStream(sessionId, request, onChunk);
  },
  cancel: async (sessionId) => {
    const { aiCancelStream } = await tauriFileApi();
    return await aiCancelStream(sessionId);
  },
  confirm: async (pluginName, model, preview) => {
    const zh = appLocale.value.startsWith("zh");
    const message = zh ? `插件「${pluginName}」将把准备的文本发送给「${model.name} / ${model.model}」，并读取生成结果。` : `Plugin "${pluginName}" will send its prepared text to "${model.name} / ${model.model}" and receive the generated result.`;
    const contextLabel = formatPluginAiContextLabel();
    return await new Promise<PluginAiConfirmDecision>((resolve) => {
      aiConfirmResolve = resolve;
      aiConfirmRemember.value = false;
      aiConfirmDialog.value = {
        title: zh ? "插件 AI 生成" : "Plugin AI generation",
        message,
        preview,
        previewHeading: zh ? "将发送的内容（首行）" : "Content to send (first line)",
        sizeLabel: zh ? `全文 ${preview.bytes} 字节` : `${preview.bytes} bytes total`,
        contextLabel: contextLabel ? `${zh ? "上下文" : "Context"}: ${contextLabel}` : "",
        rememberLabel: zh ? "本工作台内不再询问" : "Don't ask again in this workbench",
        continueLabel: zh ? "继续" : "Continue",
        cancelLabel: zh ? "取消" : "Cancel",
      };
    });
  },
});
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
// Boot timing (§8.3 loading lifecycle): one console.debug line per iframe load
// so panel-open latency can be attributed (doc cache / sandbox doc / parse+exec).
let bootStartedAt = 0;
let bootCacheHit = false;

// --- Plugin file-transfer bridge (native dialogs + OS file drops) ---------
// The sandboxed iframe cannot reach local files, so handles live here: Tauri
// handles wrap the plugin_file registry in Rust (`t<uuid>` ids); the web host
// keeps File objects and in-memory save buffers (`w<n>` ids). Handle ids are
// opaque strings end to end — never run them through Number(): ids above
// Number.MAX_SAFE_INTEGER silently round, and the registry then rejects every
// read with "unknown plugin file handle". Every path is consented to on the
// Rust side — dialogs open there (plugin_file_pick_files / plugin_file_save_as)
// and drops are registered by the native drag-drop pipeline before
// plugin_file_open_dropped accepts them — never a plugin-supplied string.

let webFileSequence = 0;
const webPickedFiles = new Map<string, File>();
const webSaveBuffers = new Map<string, { name: string; contentType: string; chunks: Map<number, Uint8Array> }>();
// raw handle id -> the plugin id that opened it, recorded at open time.
// Teardown closes precisely these handles: an owner-wide sweep would also
// kill the SAME plugin's handles held by a sibling workbench instance, so it
// is reserved for Rust-side lifecycle (stop/uninstall) only.
const openTauriHandles = new Map<string, string>();
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

function parseHandleId(handleId: string): { source: "tauri" | "web"; rawId: string } {
  if (handleId.startsWith(tauriHandlePrefix)) return { source: "tauri", rawId: handleId.slice(tauriHandlePrefix.length) };
  if (handleId.startsWith(webHandlePrefix)) return { source: "web", rawId: handleId.slice(webHandlePrefix.length) };
  throw new Error("Unknown file handle");
}

/** Loaded lazily: the static tauri module drags side-effectful imports (i18n boot)
 *  into specs that mock the whole backend layer. */
async function tauriFileApi() {
  return import("@/lib/backend/tauri");
}

// OS drops are the one flow where the renderer still names a path: the native
// drag-drop pipeline registered the dropped paths for THIS webview, and
// plugin_file_open_dropped accepts exactly those (one open attempt per dropped
// path). A dropped folder comes back expanded to its contained files on the
// Rust side, with `truncated` flagging any cap cutoff and a `dropId` grouping
// the entries of this one drop.
async function openDroppedPluginFiles(pluginId: string, paths: string[]): Promise<{ dropId: string; truncated: boolean; files: PluginFileHandleMeta[] }> {
  const { openDroppedPluginLocalFiles } = await tauriFileApi();
  const result = await openDroppedPluginLocalFiles(pluginId, paths);
  const files = result.files.map((handle) => {
    openTauriHandles.set(handle.handleId, pluginId);
    const meta: PluginFileHandleMeta = { handleId: `${tauriHandlePrefix}${handle.handleId}`, name: handle.name, size: handle.size, contentType: handle.contentType };
    if (handle.relativePath) meta.relativePath = handle.relativePath;
    return meta;
  });
  return { dropId: result.dropId, truncated: result.truncated, files };
}

async function pickPluginFiles(pluginId: string, options: PluginPickFilesOptions): Promise<PluginFileHandleMeta[]> {
  if (isTauriRuntime()) {
    // The native dialog is opened on the Rust side: paths never round-trip
    // through renderer-controlled arguments, the handles are the only result.
    const { pickPluginLocalFiles } = await tauriFileApi();
    const files: PluginFileHandleMeta[] = [];
    for (const handle of await pickPluginLocalFiles(pluginId, options.multiple === true)) {
      // Track read AND write handles: unmount must reclaim both (leaked fds
      // also burn the shared 64-handle registry quota).
      openTauriHandles.set(handle.handleId, pluginId);
      files.push({ handleId: `${tauriHandlePrefix}${handle.handleId}`, name: handle.name, size: handle.size, contentType: handle.contentType });
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
    return readPluginLocalFileChunk(pluginId, parsed.rawId, offset, length);
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
    // The save dialog runs on the Rust side and returns an already-consented
    // write handle; only the suggested file name crosses the bridge. Track it
    // in openTauriHandles: a beginSave the plugin abandons must still be
    // reclaimed on unmount instead of burning the shared registry quota.
    const { savePluginLocalFileAs } = await tauriFileApi();
    const handle = await savePluginLocalFileAs(pluginId, request.name || "download.bin");
    if (!handle) return null;
    openTauriHandles.set(handle.handleId, pluginId);
    return { handleId: `${tauriHandlePrefix}${handle.handleId}`, chunkBytes: PLUGIN_SAVE_CHUNK_BYTES };
  }
  const handleId = `${webHandlePrefix}${++webFileSequence}`;
  webSaveBuffers.set(handleId, { name: request.name || "download.bin", contentType: request.contentType || "application/octet-stream", chunks: new Map() });
  return { handleId, chunkBytes: PLUGIN_SAVE_CHUNK_BYTES };
}

async function writePluginFileChunkById(pluginId: string, handleId: string, offset: number, bytes: Uint8Array): Promise<PluginFileWriteResult> {
  const parsed = parseHandleId(handleId);
  if (parsed.source === "tauri") {
    const { writePluginLocalFileChunk } = await tauriFileApi();
    return writePluginLocalFileChunk(pluginId, parsed.rawId, offset, encodeBytesBase64(bytes));
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
    await closePluginLocalFile(pluginId, parsed.rawId);
    // Drop local tracking only after the close succeeded: a failed flush
    // leaves the Rust entry alive, and the map is what unmount cleanup uses
    // to retry it.
    openTauriHandles.delete(parsed.rawId);
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
    await closePluginLocalFile(pluginId, parsed.rawId);
    openTauriHandles.delete(parsed.rawId);
    return;
  }
  webPickedFiles.delete(handleId);
  webSaveBuffers.delete(handleId);
}

function disposeLocalFileHandles(): void {
  // Close exactly the handles THIS instance opened, with the plugin id that
  // opened them — a sibling workbench of the same plugin keeps its own.
  for (const [handleId, pluginId] of openTauriHandles)
    void tauriFileApi()
      .then(({ closePluginLocalFile }) => closePluginLocalFile(pluginId, handleId))
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
  // Pin the owner and generation before the await: the expansion runs on a
  // Rust blocking thread and can land after a teardown or identity rebuild.
  const pluginId = props.plugin.manifest.id;
  const generation = loadGeneration;
  void (async () => {
    try {
      // A granted folder comes back expanded to its files; a path the drop
      // pipeline never granted (or that vanished) is skipped on the Rust side,
      // so an empty result surfaces here instead of silently handing the
      // plugin nothing while the drop looked successful.
      const { dropId, truncated, files } = await openDroppedPluginFiles(pluginId, paths);
      if (disposed || generation !== loadGeneration) {
        // The teardown already ran while the expansion was in flight: retire
        // exactly these late arrivals — a closeAll here would also kill the
        // same plugin's handles in a freshly rebuilt workbench.
        const rawIds = files.map((file) => file.handleId.replace(new RegExp(`^${tauriHandlePrefix}`), ""));
        void tauriFileApi().then(({ closePluginLocalFile }) => {
          for (const rawId of rawIds) closePluginLocalFile(pluginId, rawId).catch(() => undefined);
        });
        return;
      }
      if (files.length) bridge?.forwardFileDrop(files, { dropId, truncated });
      else console.error("[DBX][plugin-workbench:drop] no dropped files could be opened", paths);
    } catch (error) {
      console.error("[DBX][plugin-workbench:drop]", error);
    }
  })();
}

const title = computed(() => `${props.plugin.manifest.name} · ${props.contribution.label}`);

/**
 * The §8.3 surface this host renders on. The tab surface keeps a minimum height
 * (a workbench needs room to be usable); the dock and floating-window surfaces
 * are sized by their own container, where a floor would make the frame taller
 * than the visible area and swallow clicks near its bottom edge. The floating
 * surface is transparent: the widget paints its own shape.
 */
const surface = computed(() => (typeof props.context?.surface === "string" ? props.context.surface : "tab"));
const hostSurfaceClass = computed(() => (surface.value === "tab" ? "min-h-40 bg-background" : surface.value === "window" ? "min-h-0 bg-transparent" : "min-h-0 bg-background"));
/** The loading overlays must not paint an opaque box inside a transparent floating window. */
const overlayClass = computed(() => (surface.value === "window" ? "bg-transparent" : "bg-background"));
const isFloatingSurface = isFloatingPluginWindow();

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
      openAiConversation,
      ...(isTauriRuntime() ? aiCompletion : {}),
      setAiRecommendations: (update) => emit("recommendations", update),
      openWorkbench: async (pluginId, contributionId, context, options) => emit("openWorkbench", pluginId, contributionId, context, options),
      // §4/§5 bridge command execution, scoped to this plugin's own manifest:
      // the single-plugin registry is equivalent here because findCommand /
      // findWorkbench / enablement never cross plugins. Panel commands dock,
      // tab commands open tabs, §4.1 reuse with `instance_key` placeholder
      // scoping — identical to menu execution. Not offered on the floating
      // surface: every command action opens a shell surface (a dock entry or a
      // workbench tab) that a floating widget window does not have, so it would
      // resolve successfully and show nothing. There, plugins navigate with
      // openWorkbench / floating.open, which the host routes to the main window.
      ...(isFloatingSurface ? {} : { executeCommand: (pluginId: string, commandId: string, context?: Record<string, unknown>) => executePluginCommand(createFrontendPluginRegistry([props.plugin], appLocale.value), useQueryStore(), pluginId, commandId, context) }),
      openFilesystem: async (pluginId, providerId, context) => emit("openFilesystem", pluginId, providerId, context),
      reopenConnection: (pluginId, connectionId) => useConnectionStore().reopenPluginConnection(connectionId, pluginId),
      // PR-A4 generic extension point: a read-only, secret-free, plugin-scoped connection list (for in-panel connection switching).
      listConnections: (ownerPluginId) => {
        const providerIds = new Set((props.plugin.manifest.contributions || []).filter((candidate) => candidate.type === "connection-provider").map((candidate) => candidate.id));
        if (ownerPluginId !== props.plugin.manifest.id) return [];
        return useConnectionStore()
          .connections.filter((connection) => providerIds.has(connection.plugin_connection_provider ?? ""))
          .map((connection) => ({
            id: connection.id,
            name: connection.name,
            providerId: connection.plugin_connection_provider ?? "",
            connectionType: connection.plugin_connection_type,
            readOnly: connection.read_only === true,
          }));
      },
      // Both plan calls carry the plugin's declared `host.plans:read` gate in the
      // bridge; the backend owns EXPLAIN generation, the timeout, and the plan cap.
      getPlanCapabilities: (connectionId) => api.getPluginPlanCapabilities(connectionId),
      explainPlan: (request) => api.getPluginEstimatedPlan(request),
      getTableMetadata: (context) => api.getPluginTableMetadata(context),
      // host.data:read — the bridge asks for consent per connection before the
      // first query; the backend enforces the persisted grant on every call.
      queryData: (pluginId, request) => api.queryPluginData(pluginId, request),
      hasDataGrant: async (pluginId, connectionId) => (await api.getPluginDataGrants(pluginId)).some((grant) => grant.connectionId === connectionId),
      confirmDataAccess: (_pluginId, pluginName, connectionId) => confirmPluginDataAccess(pluginName, connectionId),
      grantDataAccess: async (pluginId, connectionId) => {
        await api.setPluginDataGrant(pluginId, connectionId, true);
      },
      closeTab: () => emit("closeTab"),
      // Floating widget windows (§8.3 surface "window"). Desktop-only: the web
      // host omits them so capabilities.floating stays false and the plugin can
      // fall back to an in-shell surface. Opening and closing work from any
      // window; the geometry calls act on the window that hosts the caller and
      // reject elsewhere, so a tab can never move a window it is not inside.
      openFloatingWindow: isTauriRuntime() ? (request) => openFloatingWindow(request) : undefined,
      closeFloatingWindows: isTauriRuntime() ? (labels) => closeFloatingWindows(labels) : undefined,
      beginFloatingDrag: isTauriRuntime() ? () => beginFloatingWindowDrag() : undefined,
      endFloatingDrag: isTauriRuntime() ? (snap) => endFloatingWindowDrag(snap) : undefined,
      setFloatingSize: isTauriRuntime() ? (width, height) => setFloatingWindowSize(width, height) : undefined,
      saveFile: (_pluginId, request, data) => savePluginFile(request, data),
      downloadFile: isTauriRuntime() ? downloadPluginFile : undefined,
      cancelDownload: isTauriRuntime() ? cancelPluginDownload : undefined,
      copyText: (_pluginId, text) => copyToClipboard(text),
      // Permission-gated in the bridge (host.clipboard:read); the helper
      // prefers the Tauri clipboard plugin and falls back to the Web Clipboard.
      clipboardRead: (_pluginId) => readTextFromClipboard(),
      clipboardReadImage: isTauriRuntime() ? (_pluginId) => readImageFromClipboard() : undefined,
      // Session consent for the first clipboard read: a native ask dialog naming
      // the plugin, so reads always have a human in the loop. On the web host
      // (no dialog surface) the callback is omitted and the bridge denies.
      confirmClipboardRead: isTauriRuntime()
        ? (_pluginId, pluginName) => import("@tauri-apps/plugin-dialog").then(({ ask }) => ask(t("pluginPlatform.clipboardReadConsent", { name: pluginName }), { title: t("pluginPlatform.clipboardReadConsentTitle"), kind: "warning" }).then((allowed) => allowed === true))
        : undefined,
      openMedia: isTauriRuntime() ? (pluginId, method, params) => tauriFileApi().then(({ openPluginMedia }) => openPluginMedia(pluginId, method, params)) : undefined,
      closeMedia: isTauriRuntime() ? (pluginId, token) => tauriFileApi().then(({ closePluginMedia }) => closePluginMedia(pluginId, token)) : undefined,
      pickFiles: (pluginId, options) => pickPluginFiles(pluginId, options),
      readFileChunk: (pluginId, handleId, offset, length) => readPluginFileChunkById(pluginId, handleId, offset, length),
      beginFileSave: (pluginId, request) => beginPluginFileSave(pluginId, request),
      writeFileChunk: (pluginId, handleId, offset, bytes) => writePluginFileChunkById(pluginId, handleId, offset, bytes),
      finishFileSave: (pluginId, handleId) => finishPluginFileSave(pluginId, handleId),
      closeFileHandle: (pluginId, handleId) => closePluginFileHandleById(pluginId, handleId),
      // OS drops (with folder expansion) are a desktop-host capability; the
      // bridge advertises it to plugins through capabilities.fileTransfer.
      receiveOsDrops: isTauriRuntime(),
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

/**
 * Consent for `host.data:read`: names the plugin and the connection so the
 * user sees exactly what is shared. An allow is persisted as a grant the
 * Plugin Center can revoke; the web host asks through the browser dialog.
 */
async function confirmPluginDataAccess(pluginName: string, connectionId: string): Promise<boolean> {
  const connectionName = useConnectionStore().getConfig(connectionId)?.name || connectionId;
  const message = t("pluginPlatform.dataAccessConsent", { name: pluginName, connection: connectionName });
  const title = t("pluginPlatform.dataAccessConsentTitle");
  if (isTauriRuntime()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return (await ask(message, { title, kind: "warning" })) === true;
  }
  return window.confirm(`${title}\n\n${message}`);
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
  // An identity rebuild swaps the plugin this component serves; retire the
  // previous plugin's handles first or they would outlive their owner.
  disposeLocalFileHandles();
  bridge?.dispose();
  bridge = undefined;
  loading.value = true;
  frameReady.value = false;
  error.value = "";
  bootStartedAt = performance.now();
  bootCacheHit = true;
  try {
    if (!props.plugin.compatibility.compatible) throw new Error((props.plugin.compatibility.errors || []).join("; ") || t("pluginPlatform.pluginIncompatible"));
    // The read/decode/inline pipeline over a multi-megabyte ui build dominates
    // workbench open time; cache the inlined html per plugin id+version so
    // reopening panels (new dock entries, workbench reloads) skips it. Theme
    // is applied per load via the sandbox document, so the cache never pins a
    // stale appearance. getOrLoadPluginUiHtml coalesces with an in-flight
    // warm (dock "+" picker) so the panel never duplicates a running pipeline.
    const htmlCacheKey = `${props.plugin.manifest.id}:${props.plugin.manifest.version}`;
    let cachedHtml = getCachedPluginUiHtml(htmlCacheKey);
    if (!cachedHtml) {
      bootCacheHit = false;
      cachedHtml = await getOrLoadPluginUiHtml(htmlCacheKey, props.plugin.manifest.id);
      if (disposed || generation !== loadGeneration) return;
    }
    const { html, entryDirectory } = cachedHtml;
    // The final sandbox document is cached alongside the html: generating it
    // re-runs megabyte-scale string surgery on every boot.
    if (!cachedHtml.sandboxDoc) {
      cachedHtml.sandboxDoc = pluginSandboxDocument(html, props.plugin.manifest.permissions, currentBridgeTheme(), {
        baseUrl: pluginUiBaseUrl(props.plugin.manifest.id, entryDirectory),
      });
    }
    source.value = cachedHtml.sandboxDoc;
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
  if (bootStartedAt) {
    const endedAt = performance.now();
    const bootMs = Math.round(endedAt - bootStartedAt);
    performance.measure(`pluginUi:boot:${props.plugin.manifest.id}`, { start: bootStartedAt, end: endedAt });
    bootStartedAt = 0;
    console.debug(`[plugin-ui-boot] ${props.plugin.manifest.id}@${props.plugin.manifest.version} iframeLoad=${bootMs}ms cacheHit=${bootCacheHit}`);
  }
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

/** §8.3/§7.4 two-phase close: parents await this before removing the entry so
 * the plugin can release its workbench scope (PTY sessions, subscriptions);
 * the bridge bounds the wait and resolves false on legacy/hung plugins. */
function requestClose(): Promise<boolean> {
  return bridge ? bridge.requestWorkbenchClose() : Promise.resolve(false);
}

defineExpose({ requestClose });

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  // An unanswered consent dialog must not leave the plugin's generation
  // request (and its busy lock) hanging on a dead workbench.
  resolveAiGenerationConfirm(false);
  // Best-effort §8.3 close notice for teardown paths that never called
  // requestClose (tab closes, plugin reload): the message still goes out, but
  // delivery of the plugin's cleanup is not guaranteed once the iframe dies.
  void bridge?.requestWorkbenchClose(0).catch(() => undefined);
  bridge?.dispose();
  bridge = undefined;
  window.removeEventListener("message", onMessage);
  document.removeEventListener("dbx:tauri-file-drop", onHostFileDrop);
  disposeLocalFileHandles();
  unsubscribeEvents?.();
});
</script>

<template>
  <div class="relative flex size-full overflow-hidden" :class="hostSurfaceClass">
    <div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground" :class="overlayClass">
      <Loader2 class="mr-2 size-4 animate-spin" />
      {{ t("pluginPlatform.loadingTitle", { title }) }}
    </div>
    <div v-else-if="error" class="m-auto flex max-w-lg items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <span>{{ error }}</span>
    </div>
    <template v-else>
      <!-- `allow` delegates fullscreen into the sandboxed frame: without the
           Permissions-Policy entry, requestFullscreen() rejects there no matter
           which sandbox tokens are set (the legacy `allow-fullscreen` sandbox
           flag was removed from the platform and logs an error when present). -->
      <iframe ref="iframe" :title="title" :srcdoc="source" sandbox="allow-scripts" allow="clipboard-write; fullscreen" referrerpolicy="no-referrer" class="size-full border-0 bg-transparent" @load="onFrameLoad" />
      <!-- Cover until the frame has actually painted: the iframe stays mounted
           underneath so its load event can fire (v-else on the overlay would
           deadlock), it just isn't visible yet. Fully opaque so the covered
           phase is visually identical to the host background, and faded out
           instead of removed so the reveal is never a hard swap. -->
      <div class="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground transition-opacity duration-150 ease-out" :class="[overlayClass, frameReady ? 'pointer-events-none opacity-0' : 'opacity-100']">
        <Loader2 class="mr-2 size-4 animate-spin" />
        {{ t("pluginPlatform.loadingTitle", { title }) }}
      </div>
    </template>
    <!-- Plugin AI generation consent (E2): destination, outgoing-text preview
         (first line + byte size + workbench context) and a workbench-session
         "don't ask again" option. -->
    <div v-if="aiConfirmDialog" class="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div class="w-full max-w-md rounded-xl border border-border bg-background p-4 shadow-lg">
        <h3 class="text-sm font-semibold text-foreground">{{ aiConfirmDialog.title }}</h3>
        <p class="mt-2 text-sm text-muted-foreground">{{ aiConfirmDialog.message }}</p>
        <div class="mt-3 rounded-lg border border-border bg-muted/40 p-3">
          <p class="text-xs font-medium text-muted-foreground">{{ aiConfirmDialog.previewHeading }}</p>
          <pre data-testid="plugin-ai-confirm-preview" class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{{ aiConfirmDialog.preview.firstLine || "…" }}</pre>
          <p class="mt-1 text-xs text-muted-foreground">{{ aiConfirmDialog.sizeLabel }}</p>
          <p v-if="aiConfirmDialog.contextLabel" class="mt-0.5 text-xs text-muted-foreground">{{ aiConfirmDialog.contextLabel }}</p>
        </div>
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input v-model="aiConfirmRemember" type="checkbox" data-testid="plugin-ai-confirm-remember" class="size-4 accent-[var(--color-primary)]" />
          {{ aiConfirmDialog.rememberLabel }}
        </label>
        <div class="mt-4 flex justify-end gap-2">
          <button data-testid="plugin-ai-confirm-cancel" class="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted" @click="resolveAiGenerationConfirm(false)">{{ aiConfirmDialog.cancelLabel }}</button>
          <button data-testid="plugin-ai-confirm-continue" class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90" @click="resolveAiGenerationConfirm(true)">{{ aiConfirmDialog.continueLabel }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
