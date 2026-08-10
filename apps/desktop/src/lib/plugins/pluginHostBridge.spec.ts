import { describe, expect, it, vi } from "vitest";
import { PluginHostBridge, pluginSandboxDocument } from "./pluginHostBridge";
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

  it("forwards locale changes without reloading the workbench", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.updateLocale("zh-TW");

    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "locale", locale: "zh-TW" });
  });

  it("persists bounded workbench state only for a host.workbench plugin", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const setWorkbenchState = vi.fn();
    const bridge = new PluginHostBridge(plugin(["host.workbench"]), workbench, { workbenchId: "tab-1" }, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      setWorkbenchState,
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "state", method: "host.workbenchState.set", params: { state: { sessionId: "session-1", terminalSequence: 42 } } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(setWorkbenchState).toHaveBeenCalledWith({ sessionId: "session-1", terminalSequence: 42 });
    expect(messages[0]).toMatchObject({ id: "state", result: null });
  });

  it("rejects workbench state larger than 64 KiB", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(["host.workbench"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      setWorkbenchState: vi.fn(),
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "large-state", method: "host.workbenchState.set", params: { state: { value: "x".repeat(64 * 1024) } } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0]).toMatchObject({ id: "large-state", error: "Workbench state exceeds the 64 KiB limit" });
  });

  it("acknowledges restored workbench state only through the owning host bridge", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const acknowledgeWorkbenchRestore = vi.fn();
    const bridge = new PluginHostBridge(plugin(["host.workbench"]), workbench, { workbenchId: "tab-1", restored: true }, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      acknowledgeWorkbenchRestore,
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "restore", method: "host.workbenchState.acknowledgeRestore" },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(acknowledgeWorkbenchRestore).toHaveBeenCalledOnce();
    expect(messages[0]).toMatchObject({ id: "restore", result: null });
  });

  it("serializes reactive workbench context proxies before posting init", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const reactiveContext = new Proxy({ connectionId: "proxied-connection", values: { database: "main" } }, {});
    const bridge = new PluginHostBridge(plugin(), workbench, reactiveContext, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() });

    expect(() => bridge.sendInit()).not.toThrow();
    expect(messages[0]).toMatchObject({ context: { connectionId: "proxied-connection", values: { database: "main" } } });
  });

  it("accepts opaque WebView messages only with the current bridge token", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, { invoke, notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() }, "en", "workbench-token");

    expect(
      bridge.handleWindowMessage({
        source: null,
        data: { source: "dbx-plugin", version: 1, token: "wrong-token", type: "request", id: "opaque-wrong", method: "backend.invoke", params: { method: "sample/hello" } },
      } as MessageEvent),
    ).toBe(false);
    expect(
      bridge.handleWindowMessage({
        source: null,
        data: { source: "dbx-plugin", version: 1, token: "workbench-token", type: "request", id: "opaque", method: "backend.invoke", params: { method: "sample/hello" } },
      } as MessageEvent),
    ).toBe(true);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(invoke).toHaveBeenCalledOnce();
    expect(messages[0]).toMatchObject({ source: "dbx-host", token: "workbench-token", id: "opaque", result: { ok: true } });
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

  it("does not forward connection challenges into the iframe", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(["host.events"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    bridge.forwardEvent({ pluginId: "sample", method: "connection/challenge", params: { operationId: "operation-1" } });
    expect(messages).toHaveLength(0);
  });

  it("enforces sequential bounded writes for opaque local file handles", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(["host.fileTransfer"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "save", method: "host.fileTransfer.beginSave", params: { name: "backup.bin", size: 2 } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const handleId = messages[0].result.handleId;

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "write", method: "host.fileTransfer.write", params: { handleId, offset: 1, dataBase64: "AQI=" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));

    expect(messages[1]).toMatchObject({ id: "write", error: "File transfer write offset 1 does not match expected offset 0" });
  });

  it("does not allow a handle to cross workbench bridge instances", async () => {
    const firstMessages: any[] = [];
    const secondMessages: any[] = [];
    const first = { postMessage: (message: unknown) => firstMessages.push(message) } as unknown as Window;
    const second = { postMessage: (message: unknown) => secondMessages.push(message) } as unknown as Window;
    const api = { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() };
    const firstBridge = new PluginHostBridge(plugin(["host.fileTransfer"]), workbench, {}, () => first, api);
    const secondBridge = new PluginHostBridge(plugin(["host.fileTransfer"]), workbench, {}, () => second, api);
    firstBridge.handleWindowMessage({
      source: first,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "save", method: "host.fileTransfer.beginSave", params: { name: "backup.bin" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(firstMessages).toHaveLength(1));

    secondBridge.handleWindowMessage({
      source: second,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "cancel", method: "host.fileTransfer.cancel", params: { handleId: firstMessages[0].result.handleId } },
    } as MessageEvent);
    await vi.waitFor(() => expect(secondMessages).toHaveLength(1));

    expect(secondMessages[0]).toMatchObject({ id: "cancel", error: "File transfer handle is invalid or already closed" });
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

  it("injects the SDK and a restrictive sandbox CSP", () => {
    const document = pluginSandboxDocument("<html><head></head><body>Hello</body></html>", "document-token");
    expect(document).toContain("window.dbxPlugin");
    expect(document).toContain("get locale() { return locale; }");
    expect(document).toContain("openFilesystem");
    expect(document).toContain("fileTransfer");
    expect(document).toContain("workbenchState");
    expect(document).toContain("onAppearanceChange");
    expect(document).toContain("onLocaleChange");
    expect(document).toContain("clipboard");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain('const token = "document-token"');
    expect(document).toContain("event.source !== null && event.source !== parent");
  });
});
