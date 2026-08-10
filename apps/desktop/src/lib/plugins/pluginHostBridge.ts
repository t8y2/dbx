import type { InstalledPlugin, PluginBinaryEvent, PluginEvent, PluginUiAssetPayload, PluginWorkbenchContribution } from "@/types/database";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { requestPluginClipboardReadGrant } from "@/lib/plugins/pluginClipboardPermission";

const PLUGIN_MESSAGE_SOURCE = "dbx-plugin";
const HOST_MESSAGE_SOURCE = "dbx-host";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const FILE_TRANSFER_CHUNK_BYTES = 256 * 1024;
const MAX_FILE_TRANSFER_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BUFFERED_FILE_TRANSFER_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_TRANSFER_HANDLES = 32;
const MAX_WORKBENCH_STATE_BYTES = 64 * 1024;

type LocalFileTransferHandle =
  | { kind: "source"; file: File }
  | { kind: "desktop-source"; name: string; size: number; contentType: string }
  | { kind: "target"; name: string; contentType: string; expectedSize?: number; size: number; chunks: Uint8Array[] }
  | { kind: "opfs-target"; name: string; contentType: string; expectedSize?: number; size: number; root: FileSystemDirectoryHandle; file: FileSystemFileHandle; writable: FileSystemWritableFileStream }
  | { kind: "desktop-target"; name: string; contentType: string; expectedSize?: number; size: number };

export interface PluginFileTransferFile {
  handleId: string;
  name: string;
  size: number;
  contentType: string;
}

export interface PluginWorkbenchContext {
  connectionId?: string;
  database?: string;
  schema?: string;
  values?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginAppearance {
  colorScheme: "light" | "dark";
  colors: {
    background: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    border: string;
    destructive: string;
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
  };
  ui: {
    fontFamily: string;
  };
}

export interface PluginHostBridgeApi {
  invoke<T = unknown>(pluginId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(pluginId: string, method: string, params?: unknown): Promise<void>;
  sendBinary(pluginId: string, channel: string, dataBase64: string): Promise<void>;
  readAsset(pluginId: string, path: string): Promise<PluginUiAssetPayload>;
  openWorkbench?(pluginId: string, contributionId: string, context?: PluginWorkbenchContext): Promise<void> | void;
  openFilesystem?(pluginId: string, providerId: string, context?: PluginWorkbenchContext): Promise<void> | void;
  setWorkbenchState?(state: Record<string, unknown>): Promise<void> | void;
  acknowledgeWorkbenchRestore?(): Promise<void> | void;
}

interface PluginRequestMessage {
  source: typeof PLUGIN_MESSAGE_SOURCE;
  version: typeof BRIDGE_VERSION;
  type: "request";
  id: string;
  method: string;
  params?: unknown;
}

export class PluginHostBridge {
  private readonly fileTransferHandles = new Map<string, LocalFileTransferHandle>();

  constructor(
    private readonly plugin: InstalledPlugin,
    private readonly workbench: PluginWorkbenchContribution,
    private context: PluginWorkbenchContext,
    private readonly targetWindow: () => Window | null,
    private readonly api: PluginHostBridgeApi,
    private locale = "zh-CN",
    private readonly bridgeToken = "",
    private appearance?: PluginAppearance,
  ) {}

  handleWindowMessage(event: MessageEvent): boolean {
    const target = this.targetWindow();
    if (!target || (event.source !== null && event.source !== target) || !isRecord(event.data)) return false;
    if (event.data.source !== PLUGIN_MESSAGE_SOURCE || event.data.version !== BRIDGE_VERSION) return false;
    if (this.bridgeToken && event.data.token !== this.bridgeToken) return false;
    if (event.data.type === "ready") {
      this.sendInit();
      return true;
    }
    if (event.data.type === "fileDragState") {
      if (this.hasPermission("host.fileTransfer")) this.postFileDragState(event.data.active === true);
      return true;
    }
    if (event.data.type === "fileDrop") {
      if (!this.hasPermission("host.fileTransfer")) return true;
      const files = Array.isArray(event.data.files) ? event.data.files.filter((file): file is File => file instanceof File) : [];
      void this.registerBrowserFiles(files)
        .then((registered) => this.postFileDrop(registered))
        .catch(() => this.postFileDragState(false));
      return true;
    }
    if (event.data.type !== "request" || !validRequestMessage(event.data)) return false;
    void this.handleRequest(event.data, target);
    return true;
  }

  sendInit(): void {
    this.post({
      source: HOST_MESSAGE_SOURCE,
      version: BRIDGE_VERSION,
      type: "init",
      pluginId: this.plugin.manifest.id,
      contributionId: this.workbench.id,
      locale: this.locale,
      permissions: [...(this.plugin.manifest.permissions || [])],
      context: structuredCloneSafe(this.context),
      appearance: structuredCloneSafe(this.appearance),
    });
  }

  updateContext(context: PluginWorkbenchContext): void {
    this.context = context;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "context", context: structuredCloneSafe(context) });
  }

  updateLocale(locale: string): void {
    this.locale = locale || "zh-CN";
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "locale", locale: this.locale });
  }

  updateAppearance(appearance: PluginAppearance): void {
    this.appearance = appearance;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "appearance", appearance: structuredCloneSafe(appearance) });
  }

  async forwardNativeFileDrag(type: "enter" | "over" | "leave" | "drop", paths: string[] = []): Promise<void> {
    if (!this.hasPermission("host.fileTransfer")) return;
    if (type === "leave") {
      this.postFileDragState(false);
      return;
    }
    if (type === "enter" || type === "over") {
      this.postFileDragState(true);
      return;
    }
    try {
      this.postFileDrop(await this.registerDesktopPaths(paths));
    } finally {
      this.postFileDragState(false);
    }
  }

  acceptsNativeFileDrag(): boolean {
    return this.hasPermission("host.fileTransfer");
  }

  dispose(): void {
    for (const [handleId, handle] of this.fileTransferHandles) void this.cleanupHandle(handleId, handle);
    this.fileTransferHandles.clear();
    if (isTauriRuntime()) {
      const owner = this.nativeOwner();
      void invokeDesktopFileTransfer("dispose_plugin_file_transfer_workbench", owner).catch(() => undefined);
    }
  }

  private postFileDragState(active: boolean): void {
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "fileTransferDragState", active });
  }

  private postFileDrop(files: PluginFileTransferFile[]): void {
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "fileTransferDrop", files });
  }

  forwardEvent(event: PluginEvent): void {
    if (event.pluginId !== this.plugin.manifest.id || !this.hasPermission("host.events")) return;
    // Connection challenges are consumed by the single host-level dialog.
    // Never forward them into an iframe or create a per-workbench prompt.
    if (event.method === "connection/challenge") return;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "event", method: event.method, params: event.params });
  }

  forwardBinary(event: PluginBinaryEvent): void {
    if (event.pluginId !== this.plugin.manifest.id || !this.hasPermission("host.binary")) return;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "binary", channel: event.channel, dataBase64: event.dataBase64 });
  }

  private async handleRequest(request: PluginRequestMessage, target: Window): Promise<void> {
    try {
      enforcePayloadLimit(request.params);
      const result = await this.dispatch(request.method, request.params);
      this.respond(target, request.id, { result: result ?? null });
    } catch (error) {
      this.respond(target, request.id, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "host.getContext") return structuredCloneSafe(this.context);
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
      await this.api.sendBinary(this.plugin.manifest.id, requireProtocolName(input.channel, "binary channel"), requireBase64(input.dataBase64));
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
      await this.api.openWorkbench(this.plugin.manifest.id, requireProtocolName(input.contributionId, "workbench contribution"), isRecord(input.context) ? input.context : undefined);
      return null;
    }
    if (method === "host.openFilesystem") {
      this.requirePermission("host.filesystem");
      if (!this.api.openFilesystem) throw new Error("Host filesystem navigation is unavailable");
      const input = requireRecord(params, "host.openFilesystem params");
      await this.api.openFilesystem(this.plugin.manifest.id, requireProtocolName(input.providerId, "filesystem provider"), isRecord(input.context) ? input.context : undefined);
      return null;
    }
    if (method === "host.workbenchState.set") {
      this.requirePermission("host.workbench");
      if (!this.api.setWorkbenchState) throw new Error("Host workbench state is unavailable");
      const input = requireRecord(params, "host.workbenchState.set params");
      const state = requireRecord(input.state, "workbench state");
      enforceWorkbenchStateLimit(state);
      await this.api.setWorkbenchState(structuredCloneSafe(state));
      return null;
    }
    if (method === "host.workbenchState.acknowledgeRestore") {
      this.requirePermission("host.workbench");
      if (!this.api.acknowledgeWorkbenchRestore) throw new Error("Host workbench restore acknowledgement is unavailable");
      await this.api.acknowledgeWorkbenchRestore();
      return null;
    }
    if (method === "host.clipboard.readText") {
      this.requirePermission("host.clipboard");
      if (!(await requestPluginClipboardReadGrant(this.plugin.manifest.id, this.plugin.manifest.name))) throw new Error("Clipboard read permission was denied");
      return readTextFromClipboard();
    }
    if (method === "host.clipboard.writeText") {
      this.requirePermission("host.clipboard");
      const input = requireRecord(params, "host.clipboard.writeText params");
      if (typeof input.text !== "string") throw new Error("Clipboard text must be a string");
      await copyToClipboard(input.text);
      return null;
    }
    if (method === "host.fileTransfer.pick") {
      this.requirePermission("host.fileTransfer");
      const input = params === undefined ? {} : requireRecord(params, "host.fileTransfer.pick params");
      return this.pickLocalFiles(input);
    }
    if (method === "host.fileTransfer.read") {
      this.requirePermission("host.fileTransfer");
      const input = requireRecord(params, "host.fileTransfer.read params");
      return this.readLocalFile(input);
    }
    if (method === "host.fileTransfer.beginSave") {
      this.requirePermission("host.fileTransfer");
      const input = requireRecord(params, "host.fileTransfer.beginSave params");
      return this.beginLocalSave(input);
    }
    if (method === "host.fileTransfer.write") {
      this.requirePermission("host.fileTransfer");
      const input = requireRecord(params, "host.fileTransfer.write params");
      return this.writeLocalSave(input);
    }
    if (method === "host.fileTransfer.finish") {
      this.requirePermission("host.fileTransfer");
      const input = requireRecord(params, "host.fileTransfer.finish params");
      return this.finishLocalSave(input);
    }
    if (method === "host.fileTransfer.cancel" || method === "host.fileTransfer.release") {
      this.requirePermission("host.fileTransfer");
      const input = requireRecord(params, "host.fileTransfer.cancel params");
      const handleId = requireHandleId(input.handleId);
      const handle = this.fileTransferHandles.get(handleId);
      if (!handle) throw new Error("File transfer handle is invalid or already closed");
      this.fileTransferHandles.delete(handleId);
      await this.cleanupHandle(handleId, handle);
      return null;
    }
    throw new Error(`Unsupported plugin host method '${method}'`);
  }

  private async pickLocalFiles(input: Record<string, unknown>): Promise<{ files: PluginFileTransferFile[] }> {
    if (this.fileTransferHandles.size >= MAX_FILE_TRANSFER_HANDLES) throw new Error("Too many open file transfer handles");
    const accept = input.accept === undefined ? "" : requireAcceptFilter(input.accept);
    const multiple = input.multiple === true;
    if (isTauriRuntime()) {
      const files = await invokeDesktopFileTransfer<PluginFileTransferFile[]>("pick_plugin_file_transfer_sources", {
        ...this.nativeOwner(),
        multiple,
      });
      for (const file of files) this.fileTransferHandles.set(file.handleId, { kind: "desktop-source", name: file.name, size: file.size, contentType: file.contentType });
      return { files };
    }
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = accept;
    picker.multiple = multiple;
    picker.style.display = "none";
    document.body.appendChild(picker);
    try {
      const files = await new Promise<File[]>((resolve) => {
        let settled = false;
        const finish = (selected: File[]) => {
          if (settled) return;
          settled = true;
          resolve(selected);
        };
        picker.addEventListener("change", () => finish(Array.from(picker.files || [])), { once: true });
        window.addEventListener("focus", () => setTimeout(() => finish(Array.from(picker.files || [])), 250), { once: true });
        picker.click();
      });
      return { files: await this.registerBrowserFiles(files) };
    } finally {
      picker.remove();
    }
  }

  private async readLocalFile(input: Record<string, unknown>): Promise<{ dataBase64: string; length: number; eof: boolean }> {
    const handleId = requireHandleId(input.handleId);
    const handle = this.fileTransferHandles.get(handleId);
    if (!handle || (handle.kind !== "source" && handle.kind !== "desktop-source")) throw new Error("File transfer source handle is invalid or already closed");
    const size = handle.kind === "source" ? handle.file.size : handle.size;
    const offset = requireInteger(input.offset, "offset", 0, size);
    const length = requireInteger(input.length, "length", 1, FILE_TRANSFER_CHUNK_BYTES);
    let bytes: Uint8Array;
    if (handle.kind === "source") {
      bytes = new Uint8Array(await handle.file.slice(offset, Math.min(size, offset + length)).arrayBuffer());
    } else {
      return invokeDesktopFileTransfer<{ dataBase64: string; length: number; eof: boolean }>("read_plugin_file_transfer_source", {
        ...this.nativeOwner(),
        handleId,
        offset,
        length,
      });
    }
    return { dataBase64: encodeBase64(bytes), length: bytes.byteLength, eof: offset + bytes.byteLength >= size };
  }

  private async beginLocalSave(input: Record<string, unknown>): Promise<{ handleId: string; chunkBytes: number }> {
    if (this.fileTransferHandles.size >= MAX_FILE_TRANSFER_HANDLES) throw new Error("Too many open file transfer handles");
    const name = requireDownloadName(input.name);
    const contentType = input.contentType === undefined ? "application/octet-stream" : requireContentType(input.contentType);
    const expectedSize = input.size === undefined ? undefined : requireInteger(input.size, "size", 0, MAX_FILE_TRANSFER_BYTES);
    const handleId = newTransferHandleId();
    if (isTauriRuntime()) {
      const target = await invokeDesktopFileTransfer<{ handleId: string; chunkBytes: number } | null>("begin_plugin_file_transfer_target", {
        ...this.nativeOwner(),
        name,
        expectedSize,
      });
      if (!target) throw new Error("Save cancelled");
      this.fileTransferHandles.set(target.handleId, { kind: "desktop-target", name, contentType, expectedSize, size: 0 });
      return target;
    } else if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(`.dbx-plugin-${handleId}.part`, { create: true });
      const writable = await file.createWritable();
      this.fileTransferHandles.set(handleId, { kind: "opfs-target", name, contentType, expectedSize, size: 0, root, file, writable });
    } else {
      if (expectedSize !== undefined && expectedSize > MAX_BUFFERED_FILE_TRANSFER_BYTES) {
        throw new Error("This browser cannot stream downloads larger than 1 GiB because private file storage is unavailable");
      }
      this.fileTransferHandles.set(handleId, { kind: "target", name, contentType, expectedSize, size: 0, chunks: [] });
    }
    return { handleId, chunkBytes: FILE_TRANSFER_CHUNK_BYTES };
  }

  private async writeLocalSave(input: Record<string, unknown>): Promise<{ written: number; nextOffset: number }> {
    const handleId = requireHandleId(input.handleId);
    const handle = this.fileTransferHandles.get(handleId);
    if (!handle || !isTargetHandle(handle)) throw new Error("File transfer target handle is invalid or already closed");
    const offset = requireInteger(input.offset, "offset", 0, MAX_FILE_TRANSFER_BYTES);
    if (offset !== handle.size) throw new Error(`File transfer write offset ${offset} does not match expected offset ${handle.size}`);
    const bytes = decodeBase64(requireBase64(input.dataBase64));
    if (bytes.byteLength > FILE_TRANSFER_CHUNK_BYTES) throw new Error(`File transfer chunks are limited to ${FILE_TRANSFER_CHUNK_BYTES} bytes`);
    if (handle.size + bytes.byteLength > MAX_FILE_TRANSFER_BYTES) throw new Error("File transfer exceeds the 16 GiB limit");
    if (handle.expectedSize !== undefined && handle.size + bytes.byteLength > handle.expectedSize) throw new Error("File transfer write exceeds the declared size");
    if (handle.kind === "target") {
      if (handle.size + bytes.byteLength > MAX_BUFFERED_FILE_TRANSFER_BYTES) throw new Error("This browser cannot buffer downloads larger than 1 GiB because private file storage is unavailable");
      handle.chunks.push(bytes);
    } else if (handle.kind === "opfs-target") {
      await handle.writable.write({ type: "write", position: offset, data: bytes.slice().buffer });
    } else {
      const nextOffset = await invokeDesktopFileTransfer<number>("write_plugin_file_transfer_target", {
        ...this.nativeOwner(),
        handleId,
        offset,
        dataBase64: encodeBase64(bytes),
      });
      if (nextOffset !== offset + bytes.byteLength) throw new Error("Native file transfer returned an invalid write offset");
    }
    handle.size += bytes.byteLength;
    return { written: bytes.byteLength, nextOffset: handle.size };
  }

  private async finishLocalSave(input: Record<string, unknown>): Promise<null> {
    const handleId = requireHandleId(input.handleId);
    const handle = this.fileTransferHandles.get(handleId);
    if (!handle || !isTargetHandle(handle)) throw new Error("File transfer target handle is invalid or already closed");
    if (handle.expectedSize !== undefined && handle.size !== handle.expectedSize) {
      throw new Error(`File transfer is incomplete: received ${handle.size} of ${handle.expectedSize} bytes`);
    }
    this.fileTransferHandles.delete(handleId);
    if (handle.kind === "desktop-target") {
      await invokeDesktopFileTransfer("finish_plugin_file_transfer_target", { ...this.nativeOwner(), handleId });
    } else if (handle.kind === "opfs-target") {
      await handle.writable.close();
      const blob = await handle.file.getFile();
      triggerBrowserDownload(blob, handle.name);
      await handle.root.removeEntry(handle.file.name).catch(() => undefined);
    } else {
      triggerBrowserDownload(
        new Blob(
          handle.chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer),
          { type: handle.contentType },
        ),
        handle.name,
      );
    }
    return null;
  }

  private async registerBrowserFiles(files: File[]): Promise<PluginFileTransferFile[]> {
    if (this.fileTransferHandles.size + files.length > MAX_FILE_TRANSFER_HANDLES) throw new Error("Selected files exceed the open handle limit");
    return files.map((file) => {
      if (file.size > MAX_FILE_TRANSFER_BYTES) throw new Error(`Local file '${file.name}' exceeds the 16 GiB transfer limit`);
      const handleId = newTransferHandleId();
      this.fileTransferHandles.set(handleId, { kind: "source", file });
      return { handleId, name: file.name, size: file.size, contentType: file.type || "application/octet-stream" };
    });
  }

  private async registerDesktopPaths(paths: string[]): Promise<PluginFileTransferFile[]> {
    if (!paths.length) return [];
    if (this.fileTransferHandles.size + paths.length > MAX_FILE_TRANSFER_HANDLES) throw new Error("Selected files exceed the open handle limit");
    const files = await invokeDesktopFileTransfer<PluginFileTransferFile[]>("register_dropped_plugin_file_transfer_sources", {
      ...this.nativeOwner(),
      paths,
    });
    for (const file of files) this.fileTransferHandles.set(file.handleId, { kind: "desktop-source", name: file.name, size: file.size, contentType: file.contentType });
    return files;
  }

  private async cleanupHandle(handleId: string, handle: LocalFileTransferHandle): Promise<void> {
    if (handle.kind === "opfs-target") {
      await handle.writable.abort().catch(() => undefined);
      await handle.root.removeEntry(handle.file.name).catch(() => undefined);
    } else if (handle.kind === "desktop-target" || handle.kind === "desktop-source") {
      await invokeDesktopFileTransfer("release_plugin_file_transfer_handle", { ...this.nativeOwner(), handleId }).catch(() => undefined);
    }
    this.fileTransferHandles.delete(handleId);
  }

  private requirePermission(permission: string): void {
    if (!this.hasPermission(permission)) throw new Error(`Plugin has not declared permission '${permission}'`);
  }

  private hasPermission(permission: string): boolean {
    return (this.plugin.manifest.permissions || []).includes(permission);
  }

  private nativeOwner(): { pluginId: string; workbenchId: string } {
    const workbenchId = typeof this.context.workbenchId === "string" ? this.context.workbenchId : "";
    if (!workbenchId) throw new Error("Plugin workbench context is missing workbenchId");
    return { pluginId: this.plugin.manifest.id, workbenchId };
  }

  private respond(target: Window, id: string, payload: { result?: unknown; error?: string }): void {
    target.postMessage({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, token: this.bridgeToken, type: "response", id, ...payload }, "*");
  }

  private post(message: Record<string, unknown>): void {
    this.targetWindow()?.postMessage({ ...message, token: this.bridgeToken }, "*");
  }
}

function isTargetHandle(handle: LocalFileTransferHandle): handle is Extract<LocalFileTransferHandle, { kind: "target" | "opfs-target" | "desktop-target" }> {
  return handle.kind === "target" || handle.kind === "opfs-target" || handle.kind === "desktop-target";
}

async function invokeDesktopFileTransfer<T = void>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function triggerBrowserDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function pluginSandboxDocument(html: string, bridgeToken = ""): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; connect-src 'none'; media-src data: blob:;">`;
  const sdk = `<script>${pluginSdkSource(bridgeToken)}</script>`;
  const injection = `${csp}${sdk}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injection}`);
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}

function pluginSdkSource(bridgeToken: string): string {
  return `(() => {
    const token = ${JSON.stringify(bridgeToken)};
    const pending = new Map();
    const listeners = { event: new Set(), binary: new Set(), init: new Set(), appearance: new Set(), locale: new Set(), context: new Set(), fileDrag: new Set(), fileDrop: new Set() };
    let sequence = 0;
    let context;
    let appearance;
    let locale = 'zh-CN';
    let permissions = [];
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, token, type: 'request', id, method, params }, '*');
    });
    const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const encode = (value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    window.dbxPlugin = Object.freeze({
      ready,
      get context() { return context; },
      get appearance() { return appearance; },
      get locale() { return locale; },
      request,
      invoke: (method, params, options = {}) => request('backend.invoke', { method, params, timeoutMs: options.timeoutMs }),
      notify: (method, params) => request('backend.notify', { method, params }),
      sendBinary: (channel, data) => request('backend.sendBinary', { channel, dataBase64: typeof data === 'string' ? data : encode(data) }),
      readAsset: (path) => request('ui.readAsset', { path }),
      readAssetUrl: async (path) => {
        const asset = await request('ui.readAsset', { path });
        return URL.createObjectURL(new Blob([decode(asset.dataBase64)], { type: asset.contentType }));
      },
      openWorkbench: (contributionId, childContext) => request('host.openWorkbench', { contributionId, context: childContext }),
      openFilesystem: (providerId, childContext) => request('host.openFilesystem', { providerId, context: childContext }),
      workbenchState: Object.freeze({
        set: (state) => request('host.workbenchState.set', { state }),
        acknowledgeRestore: () => request('host.workbenchState.acknowledgeRestore'),
      }),
      clipboard: Object.freeze({
        readText: () => request('host.clipboard.readText'),
        writeText: (text) => request('host.clipboard.writeText', { text }),
      }),
      fileTransfer: Object.freeze({
        pick: (options = {}) => request('host.fileTransfer.pick', options),
        read: (handleId, offset, length = ${FILE_TRANSFER_CHUNK_BYTES}) => request('host.fileTransfer.read', { handleId, offset, length }),
        beginSave: (options) => request('host.fileTransfer.beginSave', options),
        write: (handleId, offset, data) => request('host.fileTransfer.write', { handleId, offset, dataBase64: typeof data === 'string' ? data : encode(data) }),
        finish: (handleId) => request('host.fileTransfer.finish', { handleId }),
        cancel: (handleId) => request('host.fileTransfer.cancel', { handleId }),
        release: (handleId) => request('host.fileTransfer.release', { handleId }),
        onDragState: (listener) => { listeners.fileDrag.add(listener); return () => listeners.fileDrag.delete(listener); },
        onDrop: (listener) => { listeners.fileDrop.add(listener); return () => listeners.fileDrop.delete(listener); },
      }),
      onEvent: (listener) => { listeners.event.add(listener); return () => listeners.event.delete(listener); },
      onBinary: (listener) => { listeners.binary.add(listener); return () => listeners.binary.delete(listener); },
      onInit: (listener) => { listeners.init.add(listener); if (context !== undefined) listener(context); return () => listeners.init.delete(listener); },
      onAppearanceChange: (listener) => { listeners.appearance.add(listener); if (appearance !== undefined) listener(appearance); return () => listeners.appearance.delete(listener); },
      onLocaleChange: (listener) => { listeners.locale.add(listener); listener(locale); return () => listeners.locale.delete(listener); },
      onContextChange: (listener) => { listeners.context.add(listener); if (context !== undefined) listener(context); return () => listeners.context.delete(listener); },
      decodeBase64: decode,
      encodeBase64: encode,
    });
    let initialized = false;
    let readyTimer;
    addEventListener('message', (event) => {
      if ((event.source !== null && event.source !== parent) || !event.data || event.data.source !== '${HOST_MESSAGE_SOURCE}' || event.data.version !== ${BRIDGE_VERSION} || (token && event.data.token !== token)) return;
      const message = event.data;
      if (message.type === 'response') {
        const handler = pending.get(message.id);
        if (!handler) return;
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error)); else handler.resolve(message.result);
      } else if (message.type === 'init') {
        context = message.context;
        appearance = message.appearance;
        locale = typeof message.locale === 'string' && message.locale ? message.locale : 'zh-CN';
        permissions = Array.isArray(message.permissions) ? message.permissions : [];
        if (!initialized) {
          initialized = true;
          if (readyTimer) clearInterval(readyTimer);
          resolveReady(context);
          listeners.init.forEach((listener) => listener(context));
          dispatchEvent(new CustomEvent('dbx-plugin-init', { detail: message }));
        }
      } else if (message.type === 'appearance') {
        appearance = message.appearance;
        listeners.appearance.forEach((listener) => listener(appearance));
        dispatchEvent(new CustomEvent('dbx-plugin-appearance', { detail: appearance }));
      } else if (message.type === 'locale') {
        locale = typeof message.locale === 'string' && message.locale ? message.locale : 'zh-CN';
        listeners.locale.forEach((listener) => listener(locale));
        dispatchEvent(new CustomEvent('dbx-plugin-locale', { detail: locale }));
      } else if (message.type === 'context') {
        context = message.context;
        listeners.context.forEach((listener) => listener(context));
        dispatchEvent(new CustomEvent('dbx-plugin-context', { detail: context }));
      } else if (message.type === 'event') {
        listeners.event.forEach((listener) => listener(message));
        dispatchEvent(new CustomEvent('dbx-plugin-event', { detail: message }));
      } else if (message.type === 'binary') {
        listeners.binary.forEach((listener) => listener(message));
        dispatchEvent(new CustomEvent('dbx-plugin-binary', { detail: message }));
      } else if (message.type === 'fileTransferDragState') {
        listeners.fileDrag.forEach((listener) => listener(message.active === true));
      } else if (message.type === 'fileTransferDrop') {
        listeners.fileDrop.forEach((listener) => listener(message.files || []));
      }
    });
    const hasFileTransfer = () => permissions.includes('host.fileTransfer');
    const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    addEventListener('dragenter', (event) => {
      if (!hasFileTransfer() || !hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, token, type: 'fileDragState', active: true }, '*');
    }, true);
    addEventListener('dragover', (event) => {
      if (!hasFileTransfer() || !hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }, true);
    addEventListener('dragleave', (event) => {
      if (!hasFileTransfer()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, token, type: 'fileDragState', active: false }, '*');
    }, true);
    addEventListener('drop', (event) => {
      if (!hasFileTransfer() || !hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, token, type: 'fileDrop', files: Array.from(event.dataTransfer?.files || []) }, '*');
    }, true);
    const signalReady = () => parent.postMessage({ source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, token, type: 'ready' }, '*');
    signalReady();
    readyTimer = setInterval(() => {
      if (initialized) clearInterval(readyTimer); else signalReady();
    }, 250);
    setTimeout(() => clearInterval(readyTimer), 10000);
  })();`;
}

function validRequestMessage(value: Record<string, unknown>): value is Record<string, unknown> & PluginRequestMessage {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128 && typeof value.method === "string" && value.method.length > 0 && value.method.length <= 128;
}

function enforceWorkbenchStateLimit(state: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new Error("Workbench state must be JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKBENCH_STATE_BYTES) throw new Error("Workbench state exceeds the 64 KiB limit");
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

function requireBase64(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_BRIDGE_PAYLOAD_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Binary payload must be base64");
  return value;
}

function requireSafeAssetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plugin asset path is invalid");
  return value;
}

function requireHandleId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error("File transfer handle is invalid");
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireAcceptFilter(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || /[\r\n<>]/.test(value)) throw new Error("File accept filter is invalid");
  return value;
}

function requireDownloadName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[\\/:*?\"<>|\u0000-\u001f]/.test(value)) throw new Error("Download file name is invalid");
  return value;
}

function requireContentType(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\/-]*$/.test(value)) throw new Error("File content type is invalid");
  return value;
}

function newTransferHandleId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function enforcePayloadLimit(value: unknown): void {
  if (value === undefined) return;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_BRIDGE_PAYLOAD_BYTES) throw new Error("Plugin bridge request is too large");
}

function structuredCloneSafe<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Vue exposes component props as reactive proxies, which are valid JSON
      // data but cannot be passed directly to structuredClone/postMessage.
    }
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Plugin workbench context is not serializable");
  return JSON.parse(serialized) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
