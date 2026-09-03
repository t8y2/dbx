import type { InstalledPlugin, PluginBinaryEvent, PluginEvent, PluginUiAssetPayload, PluginWorkbenchContribution } from "@/types/database";

const PLUGIN_MESSAGE_SOURCE = "dbx-plugin";
const HOST_MESSAGE_SOURCE = "dbx-host";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_BINARY_BYTES = 8 * 1024 * 1024;

export interface PluginWorkbenchContext {
  connectionId?: string;
  database?: string;
  schema?: string;
  values?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginHostBridgeApi {
  invoke<T = unknown>(pluginId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(pluginId: string, method: string, params?: unknown): Promise<void>;
  sendBinary(pluginId: string, channel: string, dataBase64: string): Promise<void>;
  readAsset(pluginId: string, path: string): Promise<PluginUiAssetPayload>;
  openWorkbench?(pluginId: string, contributionId: string, context?: PluginWorkbenchContext): Promise<void> | void;
  openFilesystem?(pluginId: string, providerId: string, context?: PluginWorkbenchContext): Promise<void> | void;
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
  private context: PluginWorkbenchContext;
  private locale: string;

  constructor(
    private readonly plugin: InstalledPlugin,
    private readonly workbench: PluginWorkbenchContribution,
    context: PluginWorkbenchContext,
    private readonly targetWindow: () => Window | null,
    private readonly api: PluginHostBridgeApi,
    locale = "en",
  ) {
    this.context = structuredCloneSafe(context);
    this.locale = locale;
  }

  handleWindowMessage(event: MessageEvent): boolean {
    const target = this.targetWindow();
    if (!target || event.source !== target || !isRecord(event.data)) return false;
    if (event.data.source !== PLUGIN_MESSAGE_SOURCE || event.data.version !== BRIDGE_VERSION) return false;
    if (event.data.type === "ready") {
      this.sendInit();
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
    });
  }

  /**
   * Push a new workbench context into the already-loaded plugin UI instead of
   * rebuilding the iframe. Identity changes (plugin/contribution) still require
   * a full reload; context-only changes must not lose plugin state.
   */
  updateContext(context: PluginWorkbenchContext): void {
    this.context = structuredCloneSafe(context);
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "context", context: structuredCloneSafe(this.context) });
  }

  /** Notify the plugin UI about a locale change without a reload. */
  updateLocale(locale: string): void {
    this.locale = locale;
    this.post({ source: HOST_MESSAGE_SOURCE, version: BRIDGE_VERSION, type: "env", locale });
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

export function pluginSandboxDocument(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; connect-src 'none'; media-src data: blob:;">`;
  const sdk = `<script>${pluginSdkSource()}</script>`;
  const injection = `${csp}${sdk}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injection}`);
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}

function pluginSdkSource(): string {
  return `(() => {
    const pending = new Map();
    const listeners = { event: new Set(), binary: new Set(), init: new Set(), context: new Set() };
    let sequence = 0;
    let context;
    let locale = 'en';
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const request = (method, params, options = {}) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      const message = { source: '${PLUGIN_MESSAGE_SOURCE}', version: ${BRIDGE_VERSION}, type: 'request', id, method, params };
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
    window.dbxPlugin = Object.freeze({
      ready,
      get context() { return context; },
      get locale() { return locale; },
      request,
      invoke: (method, params, options = {}) => request('backend.invoke', { method, params, timeoutMs: options.timeoutMs }),
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
      openWorkbench: (contributionId, childContext) => request('host.openWorkbench', { contributionId, context: childContext }),
      openFilesystem: (providerId, childContext) => request('host.openFilesystem', { providerId, context: childContext }),
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
        context = message.context;
        locale = typeof message.locale === 'string' ? message.locale : 'en';
        resolveReady(context);
        listeners.init.forEach((listener) => listener(context));
        dispatchEvent(new CustomEvent('dbx-plugin-init', { detail: message }));
      } else if (message.type === 'context') {
        context = message.context;
        listeners.context.forEach((listener) => listener(context));
        dispatchEvent(new CustomEvent('dbx-plugin-context', { detail: context }));
      } else if (message.type === 'env') {
        if (typeof message.locale === 'string') locale = message.locale;
        listeners.event.forEach((listener) => listener(message));
        dispatchEvent(new CustomEvent('dbx-plugin-env', { detail: message }));
      } else if (message.type === 'event') {
        listeners.event.forEach((listener) => listener(message));
        dispatchEvent(new CustomEvent('dbx-plugin-event', { detail: message }));
      } else if (message.type === 'binary') {
        const payload = { channel: message.channel, data: message.data ? new Uint8Array(message.data) : new Uint8Array(0) };
        listeners.binary.forEach((listener) => listener(payload));
        dispatchEvent(new CustomEvent('dbx-plugin-binary', { detail: payload }));
      }
    });
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

function requireSafeAssetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plugin asset path is invalid");
  return value;
}

function enforcePayloadLimit(value: unknown): void {
  if (value === undefined) return;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_BRIDGE_PAYLOAD_BYTES) throw new Error("Plugin bridge request is too large");
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
