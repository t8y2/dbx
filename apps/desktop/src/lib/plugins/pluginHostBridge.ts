import type { InstalledPlugin, PluginBinaryEvent, PluginEvent, PluginUiAssetPayload, PluginUiContribution } from "@/types/database";
import { clonePluginData, snapshotPluginWorkbenchContext } from "./pluginData";
import { MAX_PLUGIN_PLAN_SQL_CHARS, MAX_PLUGIN_PLAN_TIMEOUT_MS, PLUGIN_PLAN_PERMISSION, type PluginPlanCapabilities, type PluginPlanRequest, type PluginPlanResult } from "@/types/pluginPlan";

const PLUGIN_MESSAGE_SOURCE = "dbx-plugin";
const HOST_MESSAGE_SOURCE = "dbx-host";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_BINARY_BYTES = 8 * 1024 * 1024;
// Distinct from the sidecar binary cap: saved files go straight from the
// plugin iframe to disk and never traverse plugin frames.
const MAX_BRIDGE_SAVE_BYTES = 512 * 1024 * 1024;
// Mirrors MAX_PLUGIN_PLAN_NAME_CHARS in crates/dbx-core/src/query/plugin_plan.rs.
const MAX_PLUGIN_PLAN_IDENTIFIER_CHARS = 256;

/** Structured editor appearance: SQL editor settings that have no CSS-token
 * carrier (font size is a number, the syntax theme an id). Font families are
 * additionally mirrored as `--font-sans` / `--font-mono` root tokens. */
export interface PluginEditorAppearance {
  fontFamily: string;
  fontSize: number;
  theme: string;
}

export interface PluginBridgeTheme {
  appearance: "light" | "dark";
  /** Resolved DBX design tokens (`--color-*`, `--radius-*`, `--font-*`, ...) for the current theme. */
  tokens: Record<string, string>;
  /** Editor appearance snapshot. Optional: older in-flight snapshots omit it. */
  editor?: PluginEditorAppearance;
}

export interface PluginWorkbenchContext {
  connectionId?: string;
  database?: string;
  schema?: string;
  values?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginSaveFileRequest {
  fileName?: string;
  contentType?: string;
}

export interface PluginSaveFileResult {
  path: string;
}

export interface PluginDownloadRequest extends PluginSaveFileRequest {
  downloadId: string;
  params: Record<string, unknown>;
}

/** An opened local-file handle handed to a plugin for streaming transfer. */
export interface PluginFileHandleMeta {
  handleId: string;
  name: string;
  size: number;
  contentType: string;
}

export interface PluginPickFilesOptions {
  multiple?: boolean;
}

export interface PluginFileReadChunk {
  dataBase64: string;
  length: number;
  eof: boolean;
}

export interface PluginFileWriteResult {
  written: number;
  nextOffset: number;
}

/** Chunk size the host advertises for streamed saves; fits the bridge payload cap after base64. */
export const PLUGIN_SAVE_CHUNK_BYTES = 1024 * 1024;

/**
 * Per-value cap for `host.storage` entries. The whole store is additionally
 * capped by the native host; both bounds keep this a UI-state store — bulk
 * data belongs to the sidecar's data directory.
 */
export const MAX_PLUGIN_STORAGE_VALUE_BYTES = 256 * 1024;
/** Longest accepted `host.storage` key, mirroring the native host's bound. */
export const MAX_PLUGIN_STORAGE_KEY_CHARS = 256;

export interface PluginHostBridgeApi {
  invoke<T = unknown>(pluginId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(pluginId: string, method: string, params?: unknown): Promise<void>;
  sendBinary(pluginId: string, channel: string, dataBase64: string): Promise<void>;
  readAsset(pluginId: string, path: string): Promise<PluginUiAssetPayload>;
  openWorkbench?(pluginId: string, contributionId: string, context?: PluginWorkbenchContext, options?: { forceNew?: boolean }): Promise<void> | void;
  openFilesystem?(pluginId: string, providerId: string, context?: PluginWorkbenchContext): Promise<void> | void;
  /** Explicit user-triggered reconnect of an owned plugin connection (full flow, interactive password prompt allowed). */
  reopenConnection?(pluginId: string, connectionId: string): Promise<void>;
  /**
   * Estimated plan capability metadata for one connection. Requires the plugin
   * to declare `host.plans:read`. The host only reads the stored connection
   * config; it never connects or probes the server.
   */
  getPlanCapabilities?(connectionId: string): Promise<PluginPlanCapabilities>;
  /**
   * Read-only estimated plan acquisition. Requires `host.plans:read`. The host
   * generates and owns the EXPLAIN statement; the plugin cannot pass one.
   */
  explainPlan?(request: PluginPlanRequest): Promise<PluginPlanResult>;
  closeTab?(): Promise<void> | void;
  /** Persist plugin bytes through the host's native save dialog. Resolves null when the user cancels. */
  saveFile?(pluginId: string, request: PluginSaveFileRequest, data: Uint8Array): Promise<PluginSaveFileResult | null>;
  downloadFile?(pluginId: string, request: PluginDownloadRequest, onProgress: (progress: unknown) => void): Promise<PluginSaveFileResult | null>;
  cancelDownload?(pluginId: string, downloadId: string): Promise<void>;
  /** Write text to the system clipboard on behalf of the sandboxed plugin iframe. */
  copyText?(pluginId: string, text: string): Promise<void>;
  /** Native open dialog; resolves opened read handles (null selection → empty list). */
  pickFiles?(pluginId: string, options: PluginPickFilesOptions): Promise<PluginFileHandleMeta[]>;
  /** Stream a chunk from an opened read handle. */
  readFileChunk?(pluginId: string, handleId: string, offset: number, length?: number): Promise<PluginFileReadChunk>;
  /** Native save dialog + opened write handle; resolves null when the user cancels. */
  beginFileSave?(pluginId: string, request: { name?: string; contentType?: string; size?: number }): Promise<{ handleId: string; chunkBytes: number } | null>;
  /** Stream a chunk into an opened write handle. */
  writeFileChunk?(pluginId: string, handleId: string, offset: number, bytes: Uint8Array): Promise<PluginFileWriteResult>;
  /** Flush and close an opened write handle. */
  finishFileSave?(pluginId: string, handleId: string): Promise<void>;
  /** Close any file handle, discarding unsaved state. */
  closeFileHandle?(pluginId: string, handleId: string): Promise<void>;
  /** Persistent per-plugin key-value storage for sandboxed UIs; resolves null when the key is unset. */
  storageGet?(pluginId: string, key: string): Promise<unknown>;
  storageSet?(pluginId: string, key: string, value: unknown): Promise<void>;
  storageDelete?(pluginId: string, key: string): Promise<void>;
}

interface PluginRequestMessage {
  source: typeof PLUGIN_MESSAGE_SOURCE;
  version: typeof BRIDGE_VERSION;
  type: "request";
  id: string;
  method: string;
  params?: unknown;
  /** Optional zero-copy binary payload transferred with the request. */
  data?: ArrayBuffer;
}

export class PluginHostBridge {
  private downloads = new Set<string>();
  private context: PluginWorkbenchContext;
  private locale: string;
  private theme?: PluginBridgeTheme;

  /** Invoked once before each iframe load generation sends its init message. */
  onReinit?: () => Promise<void> | void;

  constructor(
    private readonly plugin: InstalledPlugin,
    private readonly contribution: PluginUiContribution,
    context: PluginWorkbenchContext,
    private readonly targetWindow: () => Window | null,
    private readonly api: PluginHostBridgeApi,
    locale = "en",
    theme?: PluginBridgeTheme,
  ) {
    this.context = snapshotPluginWorkbenchContext(context);
    this.locale = locale;
    this.theme = theme ? clonePluginData(theme) : undefined;
  }

  handleWindowMessage(event: MessageEvent): boolean {
    const target = this.targetWindow();
    if (!target || event.source !== target || !isRecord(event.data)) return false;
    if (event.data.source !== PLUGIN_MESSAGE_SOURCE || event.data.version !== BRIDGE_VERSION) return false;
    if (event.data.type === "ready") {
      void this.handleReady();
      return true;
    }
    if (event.data.type === "shortcut" && event.data.shortcut === "closeTab") {
      void this.api.closeTab?.();
      return true;
    }
    if (event.data.type !== "request" || !validRequestMessage(event.data)) return false;
    void this.handleRequest(event.data, target);
    return true;
  }

  private handleReady(): void {
    this.requestInit("ready");
  }

  sendInit(): void {
    this.requestInit("load");
  }

  private requestInit(signal: "load" | "ready"): void {
    if ((this.initSignals.load && this.initSignals.ready) || (signal === "load" && this.initSignals.load)) {
      for (const downloadId of this.downloads) void this.api.cancelDownload?.(this.plugin.manifest.id, downloadId).catch(() => undefined);
      this.downloads.clear();
      this.initGeneration += 1;
      this.initSignals = { load: false, ready: false };
      this.initStarted = false;
    }
    if (this.initSignals[signal]) return;
    this.initSignals[signal] = true;
    if (this.initStarted) return;
    this.initStarted = true;
    const generation = this.initGeneration;
    const reinit = this.onReinit;
    if (!reinit) {
      if (!this.disposed && generation === this.initGeneration) this.postInit();
      return;
    }
    void (async () => {
      try {
        await reinit();
      } catch (error) {
        console.warn("[DBX][plugin-bridge:reinit]", error);
      }
      // A newer load generation supersedes this one; never post a stale init.
      if (!this.disposed && generation === this.initGeneration) this.postInit();
    })();
  }

  /** Stop future posts (queued inits after an async reinit) for a torn-down bridge. */
  dispose(): void {
    this.disposed = true;
    for (const downloadId of this.downloads) void this.api.cancelDownload?.(this.plugin.manifest.id, downloadId).catch(() => undefined);
    this.downloads.clear();
  }

  private disposed = false;
  private initGeneration = 0;
  private initSignals = { load: false, ready: false };
  private initStarted = false;

  private postInit(): void {
    this.post({
      source: HOST_MESSAGE_SOURCE,
      version: BRIDGE_VERSION,
      type: "init",
      pluginId: this.plugin.manifest.id,
      contributionId: this.contribution.id,
      locale: this.locale,
      theme: this.theme ? clonePluginData(this.theme) : undefined,
      permissions: [...(this.plugin.manifest.permissions || [])],
      // Additive capability advertisement: an older host omits `planApi`, and a
      // plugin must treat the absence as "unsupported" rather than probing.
      capabilities: {
        downloadFile: !!this.api.downloadFile,
        planApi: !!this.api.getPlanCapabilities && !!this.api.explainPlan,
        storage: !!this.api.storageGet && !!this.api.storageSet && !!this.api.storageDelete,
      },
      context: snapshotPluginWorkbenchContext(this.context),
    });
  }

  /**
   * Push a new workbench context into the already-loaded plugin UI instead of
   * rebuilding the iframe. Identity changes (plugin/contribution) still require
   * a full reload; context-only changes must not lose plugin state.
   */
  updateContext(context: PluginWorkbenchContext): void {
    this.context = snapshotPluginWorkbenchContext(context);
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "context", context: snapshotPluginWorkbenchContext(this.context) });
  }

  /** Notify the plugin UI about a locale change without a reload. */
  updateLocale(locale: string): void {
    this.locale = locale;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "env", locale });
  }

  /** Push resolved theme tokens so the plugin UI can follow DBX light/dark and palette changes. */
  updateTheme(theme: PluginBridgeTheme): void {
    this.theme = clonePluginData(theme);
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "env", locale: this.locale, theme: this.theme });
  }

  forwardEvent(event: PluginEvent): void {
    if (event.pluginId !== this.plugin.manifest.id || !this.hasPermission("host.events")) return;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "event", method: event.method, params: event.params });
  }

  forwardBinary(event: PluginBinaryEvent): void {
    if (event.pluginId !== this.plugin.manifest.id || !this.hasPermission("host.binary")) return;
    const target = this.targetWindow();
    if (!target) return;
    const buffer = base64ToBytes(event.dataBase64);
    target.postMessage({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "binary", channel: event.channel, data: buffer }, "*", [buffer]);
  }

  /** Tell the plugin whether an OS-level file drag is currently over its workbench. */
  forwardDragState(active: boolean): void {
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "dragstate", active });
  }

  /** Hand the plugin already-opened handles for files dropped onto its workbench. */
  forwardFileDrop(files: PluginFileHandleMeta[]): void {
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "filedrop", files });
  }

  private async handleRequest(request: PluginRequestMessage, target: Window): Promise<void> {
    try {
      enforcePayloadLimit(request.params);
      const result = await this.dispatch(request.method, request.params, request.data);
      this.respond(target, request.id, { result: result ?? null });
    } catch (error) {
      this.respond(target, request.id, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(method: string, params: unknown, binary?: ArrayBuffer): Promise<unknown> {
    if (method === "host.downloadFile") {
      if (!this.api.downloadFile) throw new Error("Streaming file downloads require the desktop host");
      const input = requireRecord(params, "download params");
      const downloadId = requireProtocolName(input.downloadId, "download ID");
      if (this.downloads.size >= 2 || this.downloads.has(downloadId)) throw new Error("Too many active downloads or duplicate download ID");
      const request = { downloadId, fileName: optionalTrimmedString(input.fileName), params: requireRecord(input.params, "download source") };
      this.downloads.add(downloadId);
      try {
        return await this.api.downloadFile(this.plugin.manifest.id, request, (progress) => {
          this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "event", method: "host.download.progress", params: progress });
        });
      } finally {
        this.downloads.delete(downloadId);
      }
    }
    if (method === "host.cancelDownload") {
      const input = requireRecord(params, "cancel download params");
      const downloadId = requireProtocolName(input.downloadId, "download ID");
      if (this.downloads.has(downloadId)) await this.api.cancelDownload?.(this.plugin.manifest.id, downloadId);
      return null;
    }
    if (method === "host.getContext") return snapshotPluginWorkbenchContext(this.context);
    if (method === "backend.invoke") {
      const input = requireRecord(params, "backend.invoke params");
      const backendMethod = requireProtocolName(input.method, "backend method");
      const timeoutMs = input.timeoutMs === undefined ? undefined : requireTimeout(input.timeoutMs);
      return this.api.invoke(this.plugin.manifest.id, backendMethod, input.params ?? null, timeoutMs);
    }
    if (method === "backend.notify") {
      const input = requireRecord(params, "backend.notify params");
      await this.api.notify(this.plugin.manifest.id, requireProtocolName(input.method, "backend method"), input.params ?? null);
      return null;
    }
    if (method === "backend.sendBinary") {
      this.requirePermission("host.binary");
      const input = requireRecord(params, "backend.sendBinary params");
      const channel = requireProtocolName(input.channel, "binary channel");
      if (binary instanceof ArrayBuffer) {
        if (binary.byteLength > MAX_BRIDGE_BINARY_BYTES) throw new Error("Plugin binary payload exceeds 8 MiB; chunk the transfer");
        await this.api.sendBinary(this.plugin.manifest.id, channel, bytesToBase64(new Uint8Array(binary)));
        return null;
      }
      await this.api.sendBinary(this.plugin.manifest.id, channel, requireBase64(input.dataBase64));
      return null;
    }
    if (method === "ui.readAsset") {
      const input = requireRecord(params, "ui.readAsset params");
      return this.api.readAsset(this.plugin.manifest.id, requireSafeAssetPath(input.path));
    }
    if (method === "host.openWorkbench") {
      this.requirePermission("host.workbench");
      if (!this.api.openWorkbench) throw new Error("Host workbench navigation is unavailable");
      const input = requireRecord(params, "host.openWorkbench params");
      await this.api.openWorkbench(this.plugin.manifest.id, requireProtocolName(input.contributionId, "workbench contribution"), isRecord(input.context) ? input.context : undefined, { forceNew: input.forceNew === true });
      return null;
    }
    if (method === "host.reopenConnection") {
      if (!this.api.reopenConnection) throw new Error("Connection reopen is unavailable");
      const input = requireRecord(params, "host.reopenConnection params");
      await this.api.reopenConnection(this.plugin.manifest.id, requireProtocolName(input.connectionId, "connectionId"));
      return { ok: true };
    }
    if (method === "host.openFilesystem") {
      this.requirePermission("host.filesystem");
      if (!this.api.openFilesystem) throw new Error("Host filesystem navigation is unavailable");
      const input = requireRecord(params, "host.openFilesystem params");
      await this.api.openFilesystem(this.plugin.manifest.id, requireProtocolName(input.providerId, "filesystem provider"), isRecord(input.context) ? input.context : undefined);
      return null;
    }
    if (method === "host.getPlanCapabilities") {
      this.requirePermission(PLUGIN_PLAN_PERMISSION);
      if (!this.api.getPlanCapabilities) throw new Error("Host plan API is unavailable");
      const input = requireRecord(params, "host.getPlanCapabilities params");
      return this.api.getPlanCapabilities(requirePluginPlanIdentifier(input.connectionId, "connectionId"));
    }
    if (method === "host.explainPlan") {
      this.requirePermission(PLUGIN_PLAN_PERMISSION);
      if (!this.api.explainPlan) throw new Error("Host plan API is unavailable");
      return this.api.explainPlan(requirePluginPlanRequest(requireRecord(params, "host.explainPlan params")));
    }
    if (method === "host.saveFile") {
      const input = isRecord(params) ? params : {};
      // The sandboxed iframe cannot trigger downloads (WKWebView cancels blob
      // navigations without a host download handler), so plugins hand the bytes
      // to the host, which runs the native save dialog and the disk write.
      let bytes: Uint8Array;
      if (binary instanceof ArrayBuffer) bytes = new Uint8Array(binary);
      else if (typeof input.dataBase64 === "string") bytes = new Uint8Array(base64ToBytes(requireBase64(input.dataBase64)));
      else throw new Error("host.saveFile requires transferred binary data or dataBase64");
      if (bytes.byteLength > MAX_BRIDGE_SAVE_BYTES) throw new Error(`Plugin save payload exceeds ${MAX_BRIDGE_SAVE_BYTES} bytes`);
      if (!this.api.saveFile) throw new Error("Host file saving is unavailable");
      return this.api.saveFile(this.plugin.manifest.id, { fileName: optionalTrimmedString(input.fileName), contentType: optionalTrimmedString(input.contentType) }, bytes);
    }
    if (method === "host.copy") {
      const input = isRecord(params) ? params : {};
      // The sandboxed workbench iframe has an opaque origin and no clipboard
      // permission, so every scripted copy path is denied there; the host
      // writes the system clipboard instead.
      if (typeof input.text !== "string" || !input.text) throw new Error("host.copy requires text");
      if (input.text.length > MAX_BRIDGE_PAYLOAD_BYTES) throw new Error(`Plugin copy payload exceeds ${MAX_BRIDGE_PAYLOAD_BYTES} characters`);
      if (!this.api.copyText) throw new Error("Host clipboard is unavailable");
      await this.api.copyText(this.plugin.manifest.id, input.text);
      return { success: true };
    }
    if (method === "host.pickFiles") {
      // Same trust level as host.saveFile: the bytes only flow after the user
      // picked the files in the native dialog, so no manifest permission gate.
      const input = isRecord(params) ? params : {};
      if (!this.api.pickFiles) throw new Error("Host file picking is unavailable");
      const files = await this.api.pickFiles(this.plugin.manifest.id, { multiple: input.multiple === true });
      return { files };
    }
    if (method === "host.readFileChunk") {
      const input = requireRecord(params, "host.readFileChunk params");
      if (!this.api.readFileChunk) throw new Error("Host file reading is unavailable");
      return this.api.readFileChunk(this.plugin.manifest.id, requireHandleId(input.handleId), requireOffset(input.offset), input.length === undefined ? undefined : requireChunkLength(input.length));
    }
    if (method === "host.beginFileSave") {
      const input = isRecord(params) ? params : {};
      if (!this.api.beginFileSave) throw new Error("Host file saving is unavailable");
      const target = await this.api.beginFileSave(this.plugin.manifest.id, {
        name: optionalTrimmedString(input.name),
        contentType: optionalTrimmedString(input.contentType),
        size: input.size === undefined || typeof input.size !== "number" || !Number.isFinite(input.size) ? undefined : Math.max(0, Math.floor(input.size)),
      });
      // Cancelled saves resolve null, exactly as the documented contract and
      // every plugin's env.d.ts types it.
      return target;
    }
    if (method === "host.writeFileChunk") {
      const input = requireRecord(params, "host.writeFileChunk params");
      if (!this.api.writeFileChunk) throw new Error("Host file writing is unavailable");
      const bytes = binary instanceof ArrayBuffer ? new Uint8Array(binary) : new Uint8Array(base64ToBytes(requireBase64(input.dataBase64)));
      if (bytes.byteLength > MAX_BRIDGE_BINARY_BYTES) throw new Error("Plugin write chunk exceeds 8 MiB");
      return this.api.writeFileChunk(this.plugin.manifest.id, requireHandleId(input.handleId), requireOffset(input.offset), bytes);
    }
    if (method === "host.finishFileSave") {
      const input = requireRecord(params, "host.finishFileSave params");
      if (!this.api.finishFileSave) throw new Error("Host file saving is unavailable");
      await this.api.finishFileSave(this.plugin.manifest.id, requireHandleId(input.handleId));
      return null;
    }
    if (method === "host.closeFileHandle") {
      const input = requireRecord(params, "host.closeFileHandle params");
      if (!this.api.closeFileHandle) throw new Error("Host file handling is unavailable");
      await this.api.closeFileHandle(this.plugin.manifest.id, requireHandleId(input.handleId));
      return null;
    }
    if (method === "host.storageGet") {
      this.requirePermission("host.storage");
      if (!this.api.storageGet) throw new Error("Host storage is unavailable");
      const input = requireRecord(params, "host.storageGet params");
      return this.api.storageGet(this.plugin.manifest.id, requireStorageKey(input.key));
    }
    if (method === "host.storageSet") {
      this.requirePermission("host.storage");
      if (!this.api.storageSet) throw new Error("Host storage is unavailable");
      const input = requireRecord(params, "host.storageSet params");
      const key = requireStorageKey(input.key);
      // Sized before the structured clone reaches the host implementation, so
      // the native host and the web fallback enforce the same bound.
      const bytes = new TextEncoder().encode(JSON.stringify(input.value ?? null)).byteLength;
      if (bytes > MAX_PLUGIN_STORAGE_VALUE_BYTES) {
        throw new Error(`host.storage value exceeds ${MAX_PLUGIN_STORAGE_VALUE_BYTES} bytes`);
      }
      await this.api.storageSet(this.plugin.manifest.id, key, input.value ?? null);
      return null;
    }
    if (method === "host.storageDelete") {
      this.requirePermission("host.storage");
      if (!this.api.storageDelete) throw new Error("Host storage is unavailable");
      const input = requireRecord(params, "host.storageDelete params");
      await this.api.storageDelete(this.plugin.manifest.id, requireStorageKey(input.key));
      return null;
    }
    throw new Error(`Unsupported plugin host method '${method}'`);
  }

  private requirePermission(permission: string): void {
    if (!this.hasPermission(permission)) throw new Error(`Plugin has not declared permission '${permission}'`);
  }

  private hasPermission(permission: string): boolean {
    return (this.plugin.manifest.permissions || []).includes(permission);
  }

  private respond(target: Window, id: string, payload: { result?: unknown; error?: string }): void {
    target.postMessage({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "response", id, ...payload }, "*");
  }

  private post(message: Record<string, unknown>): void {
    this.targetWindow()?.postMessage(message, "*");
  }
}

/**
 * Parse `host.network:<origin>` permission entries into CSP connect-src
 * origins. Must stay aligned with `parse_host_network_permission` in
 * crates/dbx-plugin-runtime/src/plugins/manifest.rs.
 */
export function pluginNetworkOrigins(permissions: readonly string[] | undefined): string[] {
  const origins = new Set<string>();
  for (const permission of permissions || []) {
    if (!permission.startsWith("host.network:")) continue;
    const origin = permission.slice("host.network:".length);
    if (!/^https:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?$/.test(origin)) continue;
    origins.add(origin);
    if (origins.size >= 8) break;
  }
  return [...origins];
}

export interface PluginSandboxOptions {
  /**
   * Base URL under which the workbench document may fetch further plugin UI
   * assets (code-split chunks, fonts) — `dbx-plugin://localhost/<id>/assets/`
   * on native custom schemes, `http(s)://dbx-plugin.localhost/<id>/assets/`
   * where WebView2 maps the scheme to an http subdomain. Injected as the
   * document `<base>` and allowed in the resource CSP directives. Omit on
   * hosts without the plugin asset protocol (the web host).
   */
  baseUrl?: string;
}

export function pluginSandboxDocument(html: string, permissions?: readonly string[], theme?: PluginBridgeTheme, options?: PluginSandboxOptions): string {
  const networkOrigins = pluginNetworkOrigins(permissions);
  const connectSrc = networkOrigins.length > 0 ? `connect-src ${networkOrigins.join(" ")};` : "connect-src 'none';";
  const assetSource = pluginAssetCspSource(options?.baseUrl);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:${assetSource}; style-src 'unsafe-inline' blob:; img-src data: blob:${assetSource}; font-src data: blob:${assetSource}; ${connectSrc} media-src data: blob:${assetSource};">`;
  // <base> must precede every relative URL the document resolves (inlined CSS
  // url(), dynamic import specifiers), so it leads the injection.
  const base = options?.baseUrl && assetSource ? `<base href="${escapeHtmlAttribute(options.baseUrl)}">` : "";
  const sdk = `<script>${pluginSdkSource(theme)}</script>`;
  const uiKit = `<style>${pluginUiKitCss()}</style>`;
  // Placed after the uiKit so the boot `color-scheme` wins the cascade: the
  // bridge init message (and the SDK's applyTheme) only runs once the iframe
  // has loaded, and the uiKit's token fallbacks would otherwise paint the
  // first frame white on dark hosts.
  const bootTheme = pluginBootThemeCss(theme);
  const injection = `${csp}${base}${uiKit}${bootTheme ? `<style>${bootTheme}</style>` : ""}${sdk}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injection}`);
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}

/**
 * CSP source expression for the plugin asset base URL: the exact origin for
 * the http(s)-mapped form (WebView2), the whole scheme for the native custom
 * scheme form. Only dbx-plugin shapes contribute a source — anything else is
 * ignored (and suppresses the <base> too).
 */
function pluginAssetCspSource(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  const mapped = baseUrl.match(/^(https?:\/\/dbx-plugin\.localhost)(?:\/|$)/i);
  if (mapped) return ` ${mapped[1].toLowerCase()}`;
  return /^dbx-plugin:\/\//i.test(baseUrl) ? " dbx-plugin:" : "";
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pre-paint theme seed for the sandbox document. The bridge init message only
 * arrives after the iframe load event, so without this style the first frame
 * renders with the uiKit fallbacks (white background) before the real tokens
 * land — the white flash when opening a plugin workbench on a dark host.
 */
export function pluginBootThemeCss(theme?: PluginBridgeTheme): string {
  if (!theme || (theme.appearance !== "dark" && theme.appearance !== "light")) return "";
  const declarations: string[] = [`color-scheme: ${theme.appearance}`];
  const tokens = theme.tokens && typeof theme.tokens === "object" ? theme.tokens : {};
  for (const [name, value] of Object.entries(tokens)) {
    // Same name validation as the SDK's applyTheme; values must stay inside a
    // single CSS declaration so they cannot break out of the style element.
    if (!/^--[a-z0-9-]+$/i.test(name) || typeof value !== "string" || !value.trim()) continue;
    if (!/^[^"{}<>;]*$/.test(value)) continue;
    declarations.push(`${name}: ${value}`);
  }
  return `:root{${declarations.join(";")}}`;
}

/**
 * Minimal official component kit for plugin workbenches. Every class is built
 * on the DBX design tokens the host pushes through the bridge, so plugin UI
 * follows light/dark and palette changes without any plugin-side logic.
 */
export function pluginUiKitCss(): string {
  return `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-foreground, #18181b);
  background: var(--color-background, #ffffff);
}
.dbx-card {
  border: 1px solid var(--color-border, #e4e4e7);
  border-radius: var(--radius-lg, 10px);
  background: var(--color-card, #ffffff);
  padding: 14px 16px;
}
.dbx-section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-muted-foreground, #71717a);
  margin: 0 0 10px;
}
.dbx-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border, #d4d4d8);
  background: var(--color-background, #ffffff);
  color: var(--color-foreground, #18181b);
  font-size: 13px;
  cursor: pointer;
}
.dbx-btn:hover { background: var(--color-muted, #f4f4f5); }
.dbx-btn--primary { background: var(--color-primary, #2563eb); border-color: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #ffffff); }
.dbx-btn--primary:hover { background: var(--color-primary, #2563eb); opacity: 0.9; }
.dbx-btn--danger { background: var(--color-destructive, #dc2626); border-color: var(--color-destructive, #dc2626); color: var(--color-destructive-foreground, #ffffff); }
.dbx-btn--ghost { border-color: transparent; background: transparent; }
.dbx-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dbx-label { display: inline-flex; font-size: 12px; font-weight: 500; color: var(--color-foreground, #18181b); }
.dbx-input, .dbx-select, .dbx-textarea {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-input, #d4d4d8);
  background: var(--color-background, #ffffff);
  color: var(--color-foreground, #18181b);
  font-size: 13px;
  font-family: inherit;
}
.dbx-textarea { height: auto; min-height: 64px; padding: 6px 10px; resize: vertical; }
.dbx-input:focus, .dbx-select:focus, .dbx-textarea:focus { outline: 2px solid var(--color-ring, #93c5fd); outline-offset: 1px; border-color: var(--color-ring, #93c5fd); }
.dbx-hint { font-size: 12px; color: var(--color-muted-foreground, #71717a); }
.dbx-row { display: grid; grid-template-columns: minmax(96px, auto) minmax(0, 1fr); gap: 8px 12px; align-items: center; margin-bottom: 10px; }
.dbx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dbx-table th { text-align: left; font-weight: 600; color: var(--color-muted-foreground, #71717a); border-bottom: 1px solid var(--color-border, #e4e4e7); padding: 6px 8px; }
.dbx-table td { border-bottom: 1px solid var(--color-border, #e4e4e7); padding: 6px 8px; }
.dbx-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--color-primary-alpha, rgba(37, 99, 235, 0.12)); color: var(--color-primary, #2563eb); font-size: 11px; font-weight: 500; }
.dbx-link { color: var(--color-primary, #2563eb); text-decoration: none; cursor: pointer; }
.dbx-link:hover { text-decoration: underline; }
`.trim();
}

export function pluginSdkSource(initialTheme?: PluginBridgeTheme): string {
  const safeTokens = Object.fromEntries(Object.entries(initialTheme?.tokens || {}).filter(([name, value]) => /^--[a-z0-9-]+$/i.test(name) && typeof value === "string" && !!value.trim() && /^[^"{}<>;]*$/.test(value)));
  const safeInitialTheme = initialTheme && (initialTheme.appearance === "dark" || initialTheme.appearance === "light") ? { appearance: initialTheme.appearance, tokens: safeTokens } : null;
  const serializedInitialTheme = JSON.stringify(safeInitialTheme)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(() => {
    const pending = new Map();
    const listeners = { event: new Set(), binary: new Set(), init: new Set(), context: new Set(), filedrop: new Set(), dragstate: new Set() };
    let sequence = 0;
    let context;
    let locale = 'en';
    let theme;
    let capabilities = {};
    let resolveReady;
    const initialTheme = ${serializedInitialTheme};
    const applyTheme = (value) => {
      if (!value || typeof value !== 'object') return;
      theme = value;
      const root = document.documentElement;
      root.dataset.dbxTheme = theme.appearance === "dark" ? "dark" : "light";
      root.style.colorScheme = theme.appearance === "dark" ? "dark" : "light";
      const tokens = value.tokens && typeof value.tokens === 'object' ? value.tokens : {};
      for (const [name, tokenValue] of Object.entries(tokens)) {
        if (/^--[a-z0-9-]+$/i.test(name) && typeof tokenValue === 'string') root.style.setProperty(name, tokenValue);
      }
    };
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    if (initialTheme) applyTheme(initialTheme);
    // Plugin UIs routinely hand reactive state (Vue Proxy arrays/objects)
    // straight to invoke(); postMessage cannot structured-clone a Proxy and
    // WebKit rejects with "The object can not be cloned.". Mirror the host's
    // structuredCloneSafe: clone when possible, otherwise recover the plain
    // data with a JSON round-trip (the sidecar transport is JSON anyway).
    const toPlain = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch {}
      }
      return JSON.parse(JSON.stringify(value));
    };
    const request = (method, params, options = {}) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      const message = { source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, type: 'request', id, method, params: toPlain(params) };
      if (options.transfer) {
        message.data = options.transfer;
        parent.postMessage(message, '*', [options.transfer]);
      } else {
        parent.postMessage(message, '*');
      }
    });
    const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const encode = (value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const stream = async (method, params = {}, options = {}) => {
      const streamId = options.streamId || (globalThis.crypto?.randomUUID?.() || 'stream-' + Date.now() + '-' + (++sequence));
      const closeMethod = options.closeMethod || 'filesystem/stream/close';
      let removeListener;
      let closeRequested = false;
      let resolveOpen;
      let rejectOpen;
      const metadata = {};
      const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
      const readable = new ReadableStream({
        start(controller) {
          const onEvent = (message) => {
            if (message?.method !== 'host.stream.chunk' && message?.method !== 'host.stream.end' && message?.method !== 'host.stream.error') return;
            const event = message.params || {};
            if (event.streamId !== streamId) return;
            if (message.method === 'host.stream.chunk') {
              try { controller.enqueue(decode(event.dataBase64 || '')); } catch (error) { controller.error(error); }
              return;
            }
            removeListener?.();
            removeListener = undefined;
            if (message.method === 'host.stream.error') {
              const error = new Error(event.message || 'Plugin stream failed');
              rejectOpen(error);
              controller.error(error);
            } else {
              Object.assign(metadata, event);
              controller.close();
            }
          };
          removeListener = () => listeners.event.delete(onEvent);
          listeners.event.add(onEvent);
          request('backend.invoke', { method, params: { ...(params || {}), streamId }, timeoutMs: options.timeoutMs }).then(resolveOpen, (error) => {
            removeListener?.();
            removeListener = undefined;
            rejectOpen(error);
            controller.error(error);
          });
        },
        cancel() {
          removeListener?.();
          removeListener = undefined;
          if (closeRequested) return undefined;
          closeRequested = true;
          return request('backend.invoke', { method: closeMethod, params: { streamId } }).catch(() => undefined);
        },
      });
      Object.assign(metadata, await opened);
      return { stream: readable, metadata };
    };
    window.dbxPlugin = Object.freeze({
      ready,
      get context() { return context; },
      get locale() { return locale; },
      get theme() { return theme; },
      get capabilities() { return capabilities; },
      downloadFile: (options) => request('host.downloadFile', options),
      cancelDownload: (downloadId) => request('host.cancelDownload', { downloadId }),
      request,
      invoke: (method, params, options = {}) => request('backend.invoke', { method, params, timeoutMs: options.timeoutMs }),
      stream,
      notify: (method, params) => request('backend.notify', { method, params }),
      sendBinary: (channel, data) => {
        if (typeof data === 'string') return request('backend.sendBinary', { channel, dataBase64: data });
        const bytes = data instanceof ArrayBuffer ? data : (data instanceof Uint8Array ? data.buffer : new Uint8Array(data).buffer);
        return request('backend.sendBinary', { channel }, { transfer: bytes });
      },
      readAsset: (path) => request('ui.readAsset', { path }),
      readAssetUrl: async (path) => {
        const asset = await request('ui.readAsset', { path });
        return URL.createObjectURL(new Blob([decode(asset.dataBase64)], { type: asset.contentType }));
      },
      openWorkbench: (contributionId, childContext, options) => request('host.openWorkbench', { contributionId, context: childContext, forceNew: !!(options && options.forceNew) }),
      openFilesystem: (providerId, childContext) => request('host.openFilesystem', { providerId, context: childContext }),
      reopenConnection: (connectionId) => request('host.reopenConnection', { connectionId }),
      // Estimated plans only: mode must be sent explicitly so a plugin states
      // its intent, and the host refuses anything other than "estimated".
      getPlanCapabilities: (connectionId) => request('host.getPlanCapabilities', { connectionId }),
      explainPlan: (planRequest) => request('host.explainPlan', planRequest),
      saveFile: (options = {}, data) => {
        if (data === undefined) return request('host.saveFile', options);
        if (typeof data === 'string') return request('host.saveFile', { ...(options || {}), dataBase64: data });
        const bytes = data instanceof ArrayBuffer ? data : (data instanceof Uint8Array ? data.buffer : new Uint8Array(data).buffer);
        return request('host.saveFile', options, { transfer: bytes });
      },
      copy: (text) => request('host.copy', { text }),
      // Persistent per-plugin key-value state; gate on capabilities.storage
      // (older hosts omit it) and declare the host.storage permission.
      storage: Object.freeze({
        get: (key) => request('host.storageGet', { key }),
        set: (key, value) => request('host.storageSet', { key, value: value === undefined ? null : value }),
        delete: (key) => request('host.storageDelete', { key }),
      }),
      fileTransfer: Object.freeze({
        pick: (options) => request('host.pickFiles', options || {}),
        read: (handleId, offset, length) => request('host.readFileChunk', { handleId, offset, length }),
        beginSave: (options) => request('host.beginFileSave', options || {}),
        write: (handleId, offset, data) => {
          if (typeof data === 'string') return request('host.writeFileChunk', { handleId, offset, dataBase64: data });
          // A Uint8Array can be a view into a larger buffer — transferring
          // .buffer blindly would send bytes outside the view. Copy the
          // visible range into a standalone buffer first.
          const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data instanceof Uint8Array ? data.slice().buffer : new Uint8Array(data).buffer);
          return request('host.writeFileChunk', { handleId, offset }, { transfer: bytes });
        },
        finish: (handleId) => request('host.finishFileSave', { handleId }),
        cancel: (handleId) => request('host.closeFileHandle', { handleId }),
        onDragState: (listener) => { listeners.dragstate.add(listener); return () => listeners.dragstate.delete(listener); },
        onDrop: (listener) => { listeners.filedrop.add(listener); return () => listeners.filedrop.delete(listener); },
      }),
      onEvent: (listener) => { listeners.event.add(listener); return () => listeners.event.delete(listener); },
      onBinary: (listener) => { listeners.binary.add(listener); return () => listeners.binary.delete(listener); },
      onContext: (listener) => { listeners.context.add(listener); return () => listeners.context.delete(listener); },
      onInit: (listener) => { listeners.init.add(listener); if (context !== undefined) listener(context); return () => listeners.init.delete(listener); },
      decodeBase64: decode,
      encodeBase64: encode,
    });
    addEventListener('message', (event) => {
      if (event.source !== parent || !event.data || event.data.source !== '${HOST_MESSAGE_SOURCE}' || event.data.version !== ${BRIDGE_VERSION}) return;
      const message = event.data;
      if (message.type === 'response') {
        const handler = pending.get(message.id);
        if (!handler) return;
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error)); else handler.resolve(message.result);
      } else if (message.type === 'init') {
        capabilities = message.capabilities || {};
        context = message.context;
        locale = typeof message.locale === 'string' ? message.locale : 'en';
        applyTheme(message.theme);
        resolveReady(context);
        listeners.init.forEach((listener) => listener(context));
        // Plugin listeners register on the document (onHostThemeChange);
        // bare dispatchEvent targets window, which document listeners never
        // receive — env theme pushes were silently lost.
        document.dispatchEvent(new CustomEvent('dbx-plugin-init', { detail: message }));
      } else if (message.type === 'context') {
        context = message.context;
        listeners.context.forEach((listener) => listener(context));
        document.dispatchEvent(new CustomEvent('dbx-plugin-context', { detail: context }));
      } else if (message.type === 'env') {
        if (typeof message.locale === 'string') locale = message.locale;
        if (message.theme) applyTheme(message.theme);
        listeners.event.forEach((listener) => listener(message));
        document.dispatchEvent(new CustomEvent('dbx-plugin-env', { detail: message }));
      } else if (message.type === 'event') {
        listeners.event.forEach((listener) => listener(message));
        document.dispatchEvent(new CustomEvent('dbx-plugin-event', { detail: message }));
      } else if (message.type === 'binary') {
        const payload = { channel: message.channel, data: message.data ? new Uint8Array(message.data) : new Uint8Array(0) };
        listeners.binary.forEach((listener) => listener(payload));
        document.dispatchEvent(new CustomEvent('dbx-plugin-binary', { detail: payload }));
      } else if (message.type === 'filedrop') {
        const files = Array.isArray(message.files) ? message.files : [];
        listeners.filedrop.forEach((listener) => listener(files));
        document.dispatchEvent(new CustomEvent('dbx-plugin-filedrop', { detail: files }));
      } else if (message.type === 'dragstate') {
        const active = message.active === true;
        listeners.dragstate.forEach((listener) => listener(active));
        document.dispatchEvent(new CustomEvent('dbx-plugin-dragstate', { detail: active }));
      }
    });
    addEventListener('keydown', (event) => {
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (key !== 'w' || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, type: 'shortcut', shortcut: 'closeTab' }, '*');
    }, true);
    parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, type: 'ready' }, '*');
  })();`;
}

function validRequestMessage(value: Record<string, unknown>): value is Record<string, unknown> & PluginRequestMessage {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128 && typeof value.method === "string" && value.method.length > 0 && value.method.length <= 128;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireProtocolName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("timeoutMs must be a number");
  return Math.min(120_000, Math.max(1, Math.round(value)));
}

/** A connection id, database, or schema name: bounded, trimmed, never empty. */
function requirePluginPlanIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const identifier = value.trim();
  if (!identifier) throw new Error(`${label} must not be empty`);
  if (identifier.length > MAX_PLUGIN_PLAN_IDENTIFIER_CHARS) {
    throw new Error(`${label} must be at most ${MAX_PLUGIN_PLAN_IDENTIFIER_CHARS} characters`);
  }
  return identifier;
}

function optionalPluginPlanScope(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim() ? requirePluginPlanIdentifier(value, label) : undefined;
}

/**
 * Validates one `host.explainPlan` request. The host owns the EXPLAIN text, so
 * the only accepted shape is the caller's own SQL plus a connection reference
 * and an explicit `estimated` mode; anything else is refused here rather than
 * forwarded and downgraded. The backend re-checks every one of these bounds.
 */
function requirePluginPlanRequest(input: Record<string, unknown>): PluginPlanRequest {
  if (input.mode !== "estimated") throw new Error('host.explainPlan serves mode "estimated" only');
  if (typeof input.sql !== "string") throw new Error("host.explainPlan requires sql");
  const sql = input.sql.trim();
  if (!sql) throw new Error("host.explainPlan requires a non-empty sql");
  if (sql.length > MAX_PLUGIN_PLAN_SQL_CHARS) {
    throw new Error(`sql must be at most ${MAX_PLUGIN_PLAN_SQL_CHARS} characters`);
  }

  const request: PluginPlanRequest = {
    connectionId: requirePluginPlanIdentifier(input.connectionId, "connectionId"),
    sql,
    mode: "estimated",
  };
  const database = optionalPluginPlanScope(input.database, "database");
  if (database !== undefined) request.database = database;
  const schema = optionalPluginPlanScope(input.schema, "schema");
  if (schema !== undefined) request.schema = schema;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    request.timeoutMs = clampPluginPlanTimeout(input.timeoutMs);
  }
  return request;
}

/** Pre-clamps to the host ceiling; the backend additionally clamps to the connection's own timeout. */
function clampPluginPlanTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("timeoutMs must be a number");
  return Math.min(MAX_PLUGIN_PLAN_TIMEOUT_MS, Math.max(1, Math.round(value)));
}

function requireHandleId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("handleId is invalid");
  return value;
}

function requireOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("offset is invalid");
  return Math.floor(value);
}

function requireChunkLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("length is invalid");
  return Math.min(8 * 1024 * 1024, Math.floor(value));
}

/** A `host.storage` key: bounded, non-empty, no control characters. */
function requireStorageKey(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PLUGIN_STORAGE_KEY_CHARS || /[\u0000-\u001f]/.test(value)) {
    throw new Error("storage key is invalid");
  }
  return value;
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function requireBase64(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_BRIDGE_PAYLOAD_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Binary payload must be base64");
  return value;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireSafeAssetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plugin asset path is invalid");
  return value;
}

function enforcePayloadLimit(value: unknown): void {
  if (value === undefined) return;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_BRIDGE_PAYLOAD_BYTES) throw new Error("Plugin bridge request is too large");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
