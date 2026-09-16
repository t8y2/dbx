import { describe, expect, it, vi } from "vitest";
import { reactive, readonly } from "vue";
import { PluginHostBridge, pluginSandboxDocument, pluginSdkSource } from "./pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

function plugin(permissions: string[] = []): InstalledPlugin {
  return {
    manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions, drivers: [], contributions: [] },
    compatibility: { compatible: true },
  };
}

const workbench: PluginWorkbenchContribution = { type: "workbench", id: "sample.main", label: "Sample" };

describe("PluginHostBridge", () => {
  it("binds backend calls to the owning plugin identity", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke,
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    expect(
      bridge.handleWindowMessage({
        source: target,
        data: { source: "dbx-plugin", version: 1, type: "request", id: "1", method: "backend.invoke", params: { method: "sample/hello", params: { name: "DBX" } } },
      } as MessageEvent),
    ).toBe(true);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(invoke).toHaveBeenCalledWith("sample", "sample/hello", { name: "DBX" }, undefined);
    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "response", id: "1", result: { ok: true } });
  });

  it("sends the current DBX locale in the init message", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(
      plugin(),
      workbench,
      { connectionId: "connection" },
      () => target,
      {
        invoke: vi.fn(),
        notify: vi.fn(),
        sendBinary: vi.fn(),
        readAsset: vi.fn(),
      },
      "zh-CN",
    );

    bridge.sendInit();

    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "init", locale: "zh-CN", context: { connectionId: "connection" } });
  });

  it("snapshots nested Vue reactive context values before sending them to the plugin", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const context = {
      connectionId: "connection",
      values: reactive({ path: "/tmp", options: readonly({ recursive: true }) }),
    };
    const bridge = new PluginHostBridge(plugin(), workbench, context, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.sendInit();

    expect(messages[0]).toMatchObject({
      type: "init",
      context: { connectionId: "connection", values: { path: "/tmp", options: { recursive: true } } },
    });
    expect((messages[0] as { context: typeof context }).context).not.toBe(context);
  });

  it("reports unsupported plugin context values", () => {
    expect(
      () =>
        new PluginHostBridge(plugin(), workbench, { value: () => undefined }, () => null, {
          invoke: vi.fn(),
          notify: vi.fn(),
          sendBinary: vi.fn(),
          readAsset: vi.fn(),
        }),
    ).toThrow("Plugin workbench context contains an unsupported value");
  });

  it("rejects circular and oversized plugin contexts", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      () =>
        new PluginHostBridge(plugin(), workbench, circular, () => null, {
          invoke: vi.fn(),
          notify: vi.fn(),
          sendBinary: vi.fn(),
          readAsset: vi.fn(),
        }),
    ).toThrow("circular reference");

    expect(
      () =>
        new PluginHostBridge(plugin(), workbench, { value: "x".repeat(2 * 1024 * 1024) }, () => null, {
          invoke: vi.fn(),
          notify: vi.fn(),
          sendBinary: vi.fn(),
          readAsset: vi.fn(),
        }),
    ).toThrow("exceeds");
  });

  it("rejects privileged host calls without manifest permission", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      openWorkbench: vi.fn(),
    });
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "2", method: "host.openWorkbench", params: { contributionId: "sample.other" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "2", error: "Plugin has not declared permission 'host.workbench'" });
  });

  it("opens only the owning plugin filesystem with explicit permission", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const openFilesystem = vi.fn();
    const bridge = new PluginHostBridge(plugin(["host.filesystem"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      openFilesystem,
    });
    bridge.handleWindowMessage({
      source: target,
      data: {
        source: "dbx-plugin",
        version: 1,
        type: "request",
        id: "filesystem",
        method: "host.openFilesystem",
        params: { providerId: "sample.files", context: { connectionId: "connection" } },
      },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(openFilesystem).toHaveBeenCalledWith("sample", "sample.files", { connectionId: "connection" });
    expect(messages[0]).toMatchObject({ id: "filesystem", result: null });
  });

  it("forwards events and binary traffic only with declared permissions", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const sendBinary = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(["host.events", "host.binary"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary,
      readAsset: vi.fn(),
    });

    bridge.forwardEvent({ pluginId: "sample", method: "sample/progress", params: { value: 50 } });
    bridge.forwardBinary({ pluginId: "sample", channel: "pty", dataBase64: "AQI=" });
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "3", method: "backend.sendBinary", params: { channel: "pty", dataBase64: "AQI=" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(3));

    expect(messages[0]).toMatchObject({ type: "event", method: "sample/progress" });
    expect(messages[1]).toMatchObject({ type: "binary", channel: "pty" });
    expect(sendBinary).toHaveBeenCalledWith("sample", "pty", "AQI=");
    expect(messages[2]).toMatchObject({ type: "response", id: "3", result: null });
  });

  it("returns delayed responses to the iframe that issued the request", async () => {
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const first = { postMessage: (message: unknown) => firstMessages.push(message) } as unknown as Window;
    const second = { postMessage: (message: unknown) => secondMessages.push(message) } as unknown as Window;
    let current = first;
    let resolveInvoke: (value: unknown) => void = () => {};
    const invoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => current, {
      invoke,
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.handleWindowMessage({
      source: first,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "4", method: "backend.invoke", params: { method: "sample/slow" } },
    } as MessageEvent);
    current = second;
    resolveInvoke({ ok: true });
    await vi.waitFor(() => expect(firstMessages).toHaveLength(1));

    expect(firstMessages[0]).toMatchObject({ type: "response", id: "4", result: { ok: true } });
    expect(secondMessages).toHaveLength(0);
  });

  it("pushes context and locale updates without rebuilding the iframe", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, { connectionId: "first" }, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.updateContext({ connectionId: "second", values: { path: "/tmp" } });
    bridge.updateLocale("ja");

    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "context", context: { connectionId: "second" } });
    expect(messages[1]).toMatchObject({ source: "dbx-host", type: "env", locale: "ja" });

    bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id: "ctx", method: "host.getContext" } } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ type: "response", id: "ctx", result: { connectionId: "second", values: { path: "/tmp" } } });
  });

  it("accepts zero-copy binary requests and forwards binary frames as raw buffers", async () => {
    const messages: unknown[] = [];
    const target = {
      postMessage: (message: unknown, _origin?: string, _transfer?: Transferable[]) => messages.push(message),
    } as unknown as Window;
    const sendBinary = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(["host.binary"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary,
      readAsset: vi.fn(),
    });

    bridge.forwardBinary({ pluginId: "sample", channel: "pty", dataBase64: "AQID" });
    expect(messages[0]).toMatchObject({ type: "binary", channel: "pty" });
    expect((messages[0] as { data: ArrayBuffer }).data).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array((messages[0] as { data: ArrayBuffer }).data))).toEqual([1, 2, 3]);

    const bytes = new Uint8Array([4, 5, 6]).buffer;
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "bin", method: "backend.sendBinary", params: { channel: "pty" }, data: bytes },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(sendBinary).toHaveBeenCalledWith("sample", "pty", "BAUG");
    expect(messages[1]).toMatchObject({ type: "response", id: "bin", result: null });
  });

  it("rejects binary transfer requests without the host.binary permission", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "denied", method: "backend.sendBinary", params: { channel: "pty" }, data: new Uint8Array([1]).buffer },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "denied", error: "Plugin has not declared permission 'host.binary'" });
  });

  it("injects the SDK, the official UI kit, and a restrictive sandbox CSP", () => {
    const document = pluginSandboxDocument("<html><head></head><body>Hello</body></html>");
    expect(document).toContain("window.dbxPlugin");
    expect(document).toContain("get locale() { return locale; }");
    expect(document).toContain("openFilesystem");
    expect(document).toContain("saveFile");
    expect(document).toContain("document.dispatchEvent(new CustomEvent('dbx-plugin-env'");
    expect(document).toContain("shortcut: 'closeTab'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain(".dbx-btn");
    expect(document).toContain("var(--color-background");
  });

  it("bootstraps the initial theme before the plugin document paints", () => {
    const document = pluginSandboxDocument("<html><head></head><body></body></html>", [], {
      appearance: "dark",
      tokens: { "--color-background": "rgb(19 20 22)", "--color-destructive": "rgb(243 98 95)" },
    });

    expect(document).toContain('root.dataset.dbxTheme = theme.appearance === "dark" ? "dark" : "light"');
    expect(document).toContain('root.style.colorScheme = theme.appearance === "dark" ? "dark" : "light"');
    expect(document).toContain('"--color-background":"rgb(19 20 22)"');
    expect(document).toContain('"--color-destructive":"rgb(243 98 95)"');
  });

  it("forwards the plugin close-tab shortcut to the host", () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    const closeTab = vi.fn();
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      closeTab,
    });

    expect(
      bridge.handleWindowMessage({
        source: target,
        data: { source: "dbx-plugin", version: 1, type: "shortcut", shortcut: "closeTab" },
      } as MessageEvent),
    ).toBe(true);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("opens connect-src only for declared host.network origins", () => {
    const allowed = pluginSandboxDocument("<html><head></head><body></body></html>", ["host.events", "host.network:https://api.vendor.com", "host.network:https://metrics.vendor.com:8443", "host.network:http://insecure.vendor.com", "host.network:https://evil.vendor.com/path"]);
    expect(allowed).toContain("connect-src https://api.vendor.com https://metrics.vendor.com:8443;");
    expect(allowed).not.toContain("insecure.vendor.com");
    expect(allowed).not.toContain("evil.vendor.com");

    const closed = pluginSandboxDocument("<html><head></head><body></body></html>", ["host.events"]);
    expect(closed).toContain("connect-src 'none';");
    expect(closed).toContain("host.stream.chunk");
  });

  it("pre-seeds the current theme as the sandbox first paint", () => {
    const themed = pluginSandboxDocument("<html><head></head><body></body></html>", ["host.events"], { appearance: "dark", tokens: { "--color-background": "#131416", "--color-foreground": "rgb(215 215 219)" } });
    expect(themed).toContain("color-scheme: dark");
    expect(themed).toContain("--color-background: #131416");
    expect(themed).toContain("--color-foreground: rgb(215 215 219)");
    expect(themed.indexOf("<style>:root{")).toBeGreaterThan(themed.indexOf(".dbx-btn"));

    const unthemed = pluginSandboxDocument("<html><head></head><body></body></html>");
    expect(unthemed).not.toContain("color-scheme: dark");
    expect(unthemed).not.toContain("--color-background: #131416");
  });

  it("drops boot theme declarations that could break out of the style element", () => {
    const hostile = pluginSandboxDocument("<html><head></head><body></body></html>", [], {
      appearance: "dark",
      tokens: { "--color-background": "#131416", color: "red", "--evil": "red}</style><script>alert(1)</script>", "--empty": " " },
    });
    expect(hostile).toContain("--color-background: #131416");
    expect(hostile).not.toContain("--bad-name");
    expect(hostile).not.toContain("--evil");
    expect(hostile).not.toContain("--empty");
    expect((hostile.match(/<script\b/gi) ?? []).length).toBe(1);
  });

  it("sends the theme in init and pushes theme updates through env messages", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const theme = { appearance: "dark" as const, tokens: { "--color-background": "#09090b" } };
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() }, "en", theme);

    bridge.sendInit();
    expect(messages[0]).toMatchObject({ type: "init", theme: { appearance: "dark", tokens: { "--color-background": "#09090b" } } });

    bridge.updateTheme({ appearance: "light", tokens: {} });
    expect(messages[1]).toMatchObject({ type: "env", locale: "en", theme: { appearance: "light", tokens: {} } });
  });

  it("routes host.saveFile transfers through the host save dialog and reports cancellation", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const saveFile = vi.fn().mockResolvedValueOnce({ path: "/tmp/report.csv" }).mockResolvedValueOnce(null);
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      saveFile,
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "save1", method: "host.saveFile", params: { fileName: "report.csv", contentType: "text/csv" }, data: new Uint8Array([1, 2, 3]).buffer },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(saveFile).toHaveBeenCalledWith("sample", { fileName: "report.csv", contentType: "text/csv" }, new Uint8Array([1, 2, 3]));
    expect(messages[0]).toMatchObject({ type: "response", id: "save1", result: { path: "/tmp/report.csv" } });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "save2", method: "host.saveFile", params: { dataBase64: "AQID" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(saveFile).toHaveBeenLastCalledWith("sample", {}, new Uint8Array([1, 2, 3]));
    expect(messages[1]).toMatchObject({ type: "response", id: "save2", result: null });
  });

  it("rejects host.saveFile without payload or host support", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "empty", method: "host.saveFile", params: { fileName: "x.bin" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "empty", error: "host.saveFile requires transferred binary data or dataBase64" });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "unsupported", method: "host.saveFile", params: { dataBase64: "AQID" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ id: "unsupported", error: "Host file saving is unavailable" });
  });
});

describe("plugin SDK source", () => {
  interface SdkWindow {
    dbxPlugin?: { invoke: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown> };
  }

  function loadSdk(posted: unknown[], initialTheme?: { appearance: "dark" | "light"; tokens: Record<string, string> }): SdkWindow {
    const sandbox = {} as SdkWindow;
    const document = {
      documentElement: {
        dataset: {} as Record<string, string>,
        style: { colorScheme: "", setProperty: vi.fn() },
      },
      dispatchEvent: vi.fn(),
    } as unknown as Document;
    // The SDK IIFE only touches window and the bare-global addEventListener at
    // boot; parent.postMessage is captured for later request() calls, so a
    // stub window/parent is enough here.
    new Function("window", "parent", "addEventListener", "document", pluginSdkSource(initialTheme))(sandbox, { postMessage: (message: unknown) => posted.push(message) }, () => {}, document);
    return sandbox;
  }

  /** The SDK posts a `ready` message at boot; the first request follows it. */
  function firstRequest(posted: unknown[]): { type: string; method: string; params: { method: string; params: Record<string, unknown> } } {
    const request = posted.find((message) => (message as { type: string }).type === "request");
    if (!request) throw new Error("SDK posted no request message");
    return request as { type: string; method: string; params: { method: string; params: Record<string, unknown> } };
  }

  it("plainifies reactive (Proxy) params before postMessage", () => {
    const posted: unknown[] = [];
    const { dbxPlugin } = loadSdk(posted);
    expect(dbxPlugin).toBeDefined();

    // Vue reactive arrays/objects are Proxies; structured clone rejects them
    // with "The object can not be cloned." (WebKit wording) — the SDK must
    // recover the plain data before crossing the postMessage boundary.
    const reactive: string[] = ["session-a", "session-b"];
    const proxy = new Proxy(reactive, {});

    void dbxPlugin!.invoke("ssh/terminal/batchInput", { sessionIds: proxy, command: "ls -la" });

    const message = firstRequest(posted);
    expect(message.method).toBe("backend.invoke");
    expect(message.params.params).toEqual({ sessionIds: ["session-a", "session-b"], command: "ls -la" });
    // The posted sessionIds must not be the incoming Proxy itself.
    expect(message.params.params.sessionIds).not.toBe(proxy);
    expect(JSON.stringify(message.params.params.sessionIds)).toBe(JSON.stringify(["session-a", "session-b"]));
  });

  it("boots successfully when the host provides the initial theme", () => {
    const posted: unknown[] = [];
    const { dbxPlugin } = loadSdk(posted, { appearance: "dark", tokens: { "--color-background": "#131416" } });

    expect(dbxPlugin).toBeDefined();
    expect(posted[0]).toMatchObject({ source: "dbx-plugin", type: "ready" });
  });

  it("keeps cloneable values intact and plain scalars by reference", () => {
    const posted: unknown[] = [];
    const { dbxPlugin } = loadSdk(posted);

    const stamp = new Date("2026-09-06T00:00:00Z");
    void dbxPlugin!.invoke("sample/hello", { count: 3, stamp, nested: new Map([["k", "v"]]) });

    const params = firstRequest(posted).params.params as { count: number; stamp: Date; nested: Map<string, string> };
    // structuredClone path: cloneable types keep their identity class.
    expect(params.count).toBe(3);
    expect(params.stamp).toBeInstanceOf(Date);
    expect(params.nested).toBeInstanceOf(Map);
  });
});
