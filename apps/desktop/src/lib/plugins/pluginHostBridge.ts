import type { InstalledPlugin, PluginBinaryEvent, PluginEvent, PluginUiAssetPayload, PluginWorkbenchContribution } from "@/types/database";

const PLUGIN_MESSAGE_SOURCE = "dbx-plugin";
const HOST_MESSAGE_SOURCE = "dbx-host";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_BINARY_BYTES = 8 * 1024 * 1024;

export interface PluginBridgeTheme {
  appearance: "light" | "dark";
  /** Resolved DBX design tokens (`--color-*`, `--radius-*`, ...) for the current theme. */
  tokens: Record<string, string>;
}

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
  private theme?: PluginBridgeTheme;

  constructor(
    private readonly plugin: InstalledPlugin,
    private readonly workbench: PluginWorkbenchContribution,
    context: PluginWorkbenchContext,
    private readonly targetWindow: () => Window | null,
    private readonly api: PluginHostBridgeApi,
    locale = "en",
    theme?: PluginBridgeTheme,
  ) {
    this.context = structuredCloneSafe(context);
    this.locale = locale;
    this.theme = theme ? structuredCloneSafe(theme) : undefined;
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
      theme: this.theme ? structuredCloneSafe(this.theme) : undefined,
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

  /** Push resolved theme tokens so the plugin UI can follow DBX light/dark and palette changes. */
  updateTheme(theme: PluginBridgeTheme): void {
    this.theme = structuredCloneSafe(theme);
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

/**
 * Parse `host.network:<origin>` permission entries into CSP connect-src
 * origins. Must stay aligned with `parse_host_network_permission` in
 * crates/dbx-core/src/plugins/manifest.rs.
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

export function pluginSandboxDocument(html: string, permissions?: readonly string[]): string {
  const networkOrigins = pluginNetworkOrigins(permissions);
  const connectSrc = networkOrigins.length > 0 ? `connect-src ${networkOrigins.join(" ")};` : "connect-src 'none';";
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; ${connectSrc} media-src data: blob:;">`;
  const sdk = `<script>${pluginSdkSource()}</script>`;
  const uiKit = `<style>${pluginUiKitCss()}</style>`;
  const injection = `${csp}${uiKit}${sdk}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injection}`);
  return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
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

function pluginSdkSource(): string {
  return `(() => {
    const pending = new Map();
    const listeners = { event: new Set(), binary: new Set(), init: new Set(), context: new Set() };
    let sequence = 0;
    let context;
    let locale = 'en';
    let theme;
    let resolveReady;
    const applyTheme = (value) => {
      if (!value || typeof value !== 'object') return;
      theme = value;
      const root = document.documentElement;
      root.dataset.dbxTheme = value.appearance === 'dark' ? 'dark' : 'light';
      const tokens = value.tokens && typeof value.tokens === 'object' ? value.tokens : {};
      for (const [name, tokenValue] of Object.entries(tokens)) {
        if (/^--[a-z0-9-]+$/i.test(name) && typeof tokenValue === 'string') root.style.setProperty(name, tokenValue);
      }
    };
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
      get theme() { return theme; },
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
        applyTheme(message.theme);
        resolveReady(context);
        listeners.init.forEach((listener) => listener(context));
        dispatchEvent(new CustomEvent('dbx-plugin-init', { detail: message }));
      } else if (message.type === 'context') {
        context = message.context;
        listeners.context.forEach((listener) => listener(context));
        dispatchEvent(new CustomEvent('dbx-plugin-context', { detail: context }));
      } else if (message.type === 'env') {
        if (typeof message.locale === 'string') locale = message.locale;
        if (message.theme) applyTheme(message.theme);
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
