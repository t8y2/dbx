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

  it("injects the SDK and a restrictive sandbox CSP", () => {
    const document = pluginSandboxDocument("<html><head></head><body>Hello</body></html>");
    expect(document).toContain("window.dbxPlugin");
    expect(document).toContain("get locale() { return locale; }");
    expect(document).toContain("openFilesystem");
    expect(document).toContain("connect-src 'none'");
  });
});
