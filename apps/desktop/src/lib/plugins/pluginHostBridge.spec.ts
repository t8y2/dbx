import { describe, expect, it, vi } from "vitest";
import { reactive, readonly } from "vue";
import { PluginHostBridge, pluginSandboxDocument, pluginSdkSource } from "./pluginHostBridge";
import type { InstalledPlugin, PluginResultViewContribution, PluginWorkbenchContribution } from "@/types/database";

function plugin(permissions: string[] = []): InstalledPlugin {
  return {
    manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions, drivers: [], contributions: [] },
    compatibility: { compatible: true },
  };
}

const workbench: PluginWorkbenchContribution = { type: "workbench", id: "sample.main", label: "Sample" };
const resultView: PluginResultViewContribution = { type: "result-view", id: "sample.graph", label: "Graph" };

describe("PluginHostBridge", () => {
  it("streams downloads under the owning plugin, scopes cancellation and reports native capability", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    let finish!: (value: null) => void;
    const downloadFile = vi.fn((_pluginId, _request, onProgress) => {
      onProgress({ downloadId: "download-1", sent: 300 * 1024 * 1024 });
      return new Promise<null>((resolve) => {
        finish = resolve;
      });
    });
    const cancelDownload = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      downloadFile,
      cancelDownload,
    });
    const send = (id: string, method: string, params: unknown) => bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id, method, params } } as MessageEvent);
    bridge.sendInit();
    expect(messages[0].capabilities.downloadFile).toBe(true);
    send("open", "host.downloadFile", { downloadId: "download-1", fileName: "report.bin", params: { uri: "s3://bucket/report.bin" }, pluginId: "other" });
    await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
    expect(downloadFile.mock.calls[0][0]).toBe("sample");
    expect(messages.some((message) => message.method === "host.download.progress" && message.params.sent === 300 * 1024 * 1024)).toBe(true);
    send("other", "host.cancelDownload", { downloadId: "someone-else" });
    expect(cancelDownload).not.toHaveBeenCalled();
    send("cancel", "host.cancelDownload", { downloadId: "download-1" });
    await vi.waitFor(() => expect(cancelDownload).toHaveBeenCalledWith("sample", "download-1"));
    finish(null);
    await vi.waitFor(() => expect(messages.some((message) => message.id === "open" && message.result === null)).toBe(true));
  });

  it("cancels unfinished native downloads when the workbench is disposed", async () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    const cancelDownload = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      downloadFile: vi.fn(() => new Promise<null>(() => {})),
      cancelDownload,
    });
    bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id: "open", method: "host.downloadFile", params: { downloadId: "owned", params: {} } } } as MessageEvent);
    bridge.dispose();
    expect(cancelDownload).toHaveBeenCalledWith("sample", "owned");
  });

  it("does not advertise native downloads on legacy or web hosts", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() });
    bridge.sendInit();
    expect(messages[0].capabilities.downloadFile).toBe(false);
    bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id: "open", method: "host.downloadFile", params: {} } } as MessageEvent);
    await vi.waitFor(() => expect(messages[1].error).toContain("desktop host"));
  });
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

  it("runs onReinit before the init message when the iframe reloads", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    const ready = () => bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "ready" } } as MessageEvent);

    const order: string[] = [];
    bridge.onReinit = () =>
      new Promise<void>((resolve) => {
        order.push("reinit");
        setTimeout(resolve, 5);
      });
    const originalPost = target.postMessage.bind(target);
    (target as { postMessage: (m: unknown) => void }).postMessage = (message: unknown) => {
      if ((message as { type?: string }).type === "init") order.push("init");
      originalPost(message);
    };

    expect(ready()).toBe(true);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(order).toEqual(["reinit", "init"]);
  });

  it("initializes only once when ready is repeated for the same bridge", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    const onReinit = vi.fn();
    bridge.onReinit = onReinit;
    const ready = () => bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "ready" } } as MessageEvent);

    ready();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    ready();

    expect(onReinit).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
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

  it("sends the opened contribution id for a result-view surface in the init message", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    // The plugin has a single UI entrypoint, so the contribution id is the only
    // signal telling its UI which declared surface was opened.
    const bridge = new PluginHostBridge(plugin(), resultView, { connectionId: "connection", sql: "SELECT 1" }, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });

    bridge.sendInit();

    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "init", pluginId: "sample", contributionId: "sample.graph", context: { connectionId: "connection", sql: "SELECT 1" } });
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

  it("passes forceNew through host.openWorkbench and defaults it to false", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const openWorkbench = vi.fn();
    const bridge = new PluginHostBridge(plugin(["host.workbench"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      openWorkbench,
    });
    const request = (id: string, params: unknown) =>
      bridge.handleWindowMessage({
        source: target,
        data: { source: "dbx-plugin", version: 1, type: "request", id, method: "host.openWorkbench", params },
      } as MessageEvent);

    request("new", { contributionId: "sample.other", context: { connectionId: "c1" }, forceNew: true });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(openWorkbench).toHaveBeenNthCalledWith(1, "sample", "sample.other", { connectionId: "c1" }, { forceNew: true });
    expect(messages[0]).toMatchObject({ id: "new", result: null });

    request("default", { contributionId: "sample.other" });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(openWorkbench).toHaveBeenNthCalledWith(2, "sample", "sample.other", undefined, { forceNew: false });
  });

  it("reopens a plugin connection through host.reopenConnection", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const reopenConnection = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      reopenConnection,
    });
    const request = (id: string, params: unknown) =>
      bridge.handleWindowMessage({
        source: target,
        data: { source: "dbx-plugin", version: 1, type: "request", id, method: "host.reopenConnection", params },
      } as MessageEvent);

    request("reopen", { connectionId: "9f1c2a34-0000-4000-8000-abcdef012345" });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(reopenConnection).toHaveBeenCalledWith("sample", "9f1c2a34-0000-4000-8000-abcdef012345");
    expect(messages[0]).toMatchObject({ id: "reopen", result: { ok: true } });

    // Missing/invalid connectionId is rejected before reaching the host.
    request("missing", {});
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ id: "missing" });
    expect((messages[1] as { error?: string }).error).toContain("connectionId");

    // Host-side failures (connection missing, not plugin-backed, connect
    // failed) surface as the request error so the plugin can show them.
    reopenConnection.mockRejectedValueOnce(new Error("Connection is not plugin-backed"));
    request("not-plugin", { connectionId: "mysql-1" });
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ id: "not-plugin", error: "Connection is not plugin-backed" });
  });

  // --- Plugin plan Host API (#9675) ----------------------------------------

  const planCapabilities = {
    dbType: "postgres",
    dbVersion: "15.19",
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 60_000, maxPlanBytes: 4 * 1024 * 1024 },
  };

  function planCall(bridge: PluginHostBridge, target: Window, method: string, params: unknown, id: string): void {
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id, method, params },
    } as MessageEvent);
  }

  function planHost() {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const getPlanCapabilities = vi.fn().mockResolvedValue(planCapabilities);
    const explainPlan = vi.fn().mockResolvedValue({
      dbType: "postgres",
      format: "json",
      rawPlan: [{ Plan: { "Node Type": "Seq Scan" } }],
      truncated: false,
      warnings: [],
    });
    return { messages, target, getPlanCapabilities, explainPlan };
  }

  it("requires host.plans:read before any plan call", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const getPlanCapabilities = vi.fn();
    const explainPlan = vi.fn();
    // Permission is the only gate: an undeclared plugin must not reach the host
    // even when the host could serve the request.
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      getPlanCapabilities,
      explainPlan,
    });

    planCall(bridge, target, "host.getPlanCapabilities", { connectionId: "c1" }, "caps");
    planCall(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated" }, "plan");
    await vi.waitFor(() => expect(messages).toHaveLength(2));

    expect(messages[0]).toMatchObject({ id: "caps", error: "Plugin has not declared permission 'host.plans:read'" });
    expect(messages[1]).toMatchObject({ id: "plan", error: "Plugin has not declared permission 'host.plans:read'" });
    expect(getPlanCapabilities).not.toHaveBeenCalled();
    expect(explainPlan).not.toHaveBeenCalled();
  });

  it("dispatches an estimated plan request and returns the raw plan", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const getPlanCapabilities = vi.fn().mockResolvedValue(planCapabilities);
    const explainPlan = vi.fn().mockResolvedValue({
      dbType: "postgres",
      format: "json",
      rawPlan: [{ Plan: { "Node Type": "Seq Scan" } }],
      truncated: true,
      warnings: ["plan_truncated"],
    });
    const bridge = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      getPlanCapabilities,
      explainPlan,
    });

    planCall(bridge, target, "host.getPlanCapabilities", { connectionId: "  c1  " }, "caps");
    planCall(bridge, target, "host.explainPlan", { connectionId: "c1", database: "app", schema: "  ", sql: "  SELECT * FROM orders  ", mode: "estimated", timeoutMs: 1_500.4 }, "plan");
    await vi.waitFor(() => expect(messages).toHaveLength(2));

    expect(getPlanCapabilities).toHaveBeenCalledWith("c1");
    // The plugin never sends EXPLAIN text: the host receives the source SQL,
    // trimmed, with blank scopes dropped rather than forwarded as empty strings.
    expect(explainPlan).toHaveBeenCalledWith({ connectionId: "c1", database: "app", sql: "SELECT * FROM orders", mode: "estimated", timeoutMs: 1_500 });
    expect(messages[0]).toMatchObject({ id: "caps", result: planCapabilities });
    expect(messages[1]).toMatchObject({
      id: "plan",
      result: { dbType: "postgres", format: "json", truncated: true, warnings: ["plan_truncated"] },
    });
  });

  it("refuses every plan mode other than estimated", async () => {
    const { messages, target, explainPlan } = planHost();
    const bridge = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      explainPlan,
    });

    // Actual plans execute the statement, so an unexpected mode is refused
    // rather than silently downgraded to an estimated one.
    for (const [id, mode] of [
      ["actual", "actual"],
      ["analyze", "analyze"],
      ["case", "Estimated"],
      ["missing", undefined],
    ] as const) {
      planCall(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode }, id);
    }
    await vi.waitFor(() => expect(messages).toHaveLength(4));

    for (const message of messages) {
      expect(message).toMatchObject({ error: 'host.explainPlan serves mode "estimated" only' });
    }
    expect(explainPlan).not.toHaveBeenCalled();
  });

  it("rejects malformed plan requests before they reach the host", async () => {
    const { messages, target, getPlanCapabilities, explainPlan } = planHost();
    const bridge = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      getPlanCapabilities,
      explainPlan,
    });

    const cases: [string, string, unknown, string][] = [
      ["caps-missing", "host.getPlanCapabilities", {}, "connectionId"],
      ["caps-blank", "host.getPlanCapabilities", { connectionId: "   " }, "connectionId"],
      ["caps-type", "host.getPlanCapabilities", { connectionId: 7 }, "connectionId"],
      ["caps-long", "host.getPlanCapabilities", { connectionId: "c".repeat(257) }, "connectionId"],
      ["sql-missing", "host.explainPlan", { connectionId: "c1", mode: "estimated" }, "sql"],
      ["sql-blank", "host.explainPlan", { connectionId: "c1", sql: "  \n ", mode: "estimated" }, "sql"],
      ["sql-long", "host.explainPlan", { connectionId: "c1", sql: "x".repeat(200_001), mode: "estimated" }, "sql"],
      ["scope-type", "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated", database: 1 }, "database"],
      ["timeout-type", "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated", timeoutMs: "soon" }, "timeoutMs"],
      ["timeout-nan", "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated", timeoutMs: Number.NaN }, "timeoutMs"],
    ];
    for (const [id, method, params] of cases) planCall(bridge, target, method, params, id);
    planCall(bridge, target, "host.explainPlan", "not an object", "params-object");
    await vi.waitFor(() => expect(messages).toHaveLength(cases.length + 1));

    cases.forEach(([id, , , expected], index) => {
      expect(messages[index]).toMatchObject({ id });
      expect((messages[index] as { error?: string }).error).toContain(expected);
    });
    expect(messages[cases.length]).toMatchObject({ id: "params-object", error: "host.explainPlan params must be an object" });
    expect(getPlanCapabilities).not.toHaveBeenCalled();
    expect(explainPlan).not.toHaveBeenCalled();
  });

  it("clamps the requested plan timeout to the host ceiling", async () => {
    const { messages, target, explainPlan } = planHost();
    const bridge = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      explainPlan,
    });

    planCall(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated", timeoutMs: 10 * 60_000 }, "huge");
    planCall(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated", timeoutMs: -5 }, "tiny");
    planCall(bridge, target, "host.explainPlan", { connectionId: "c1", sql: "SELECT 1", mode: "estimated" }, "absent");
    await vi.waitFor(() => expect(messages).toHaveLength(3));

    expect(explainPlan.mock.calls[0][0].timeoutMs).toBe(60_000);
    expect(explainPlan.mock.calls[1][0].timeoutMs).toBe(1);
    // No timeout is a host decision; the bridge must not invent one.
    expect(explainPlan.mock.calls[2][0]).not.toHaveProperty("timeoutMs");
  });

  it("advertises the plan API only when the host can serve it", async () => {
    const messages: any[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const base = { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() };

    const capable = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, {
      ...base,
      getPlanCapabilities: vi.fn().mockResolvedValue(planCapabilities),
      explainPlan: vi.fn().mockResolvedValue({ dbType: "postgres", format: "json", rawPlan: {}, truncated: false, warnings: [] }),
    });
    capable.sendInit();
    expect(messages[0].capabilities).toMatchObject({ planApi: true });

    // An older host omits the adapters: the plugin must see planApi false and
    // get an explicit failure instead of a silent no-op.
    const legacy = new PluginHostBridge(plugin(["host.plans:read"]), workbench, {}, () => target, { ...base });
    legacy.sendInit();
    expect(messages[1].capabilities).toMatchObject({ planApi: false });
    planCall(legacy, target, "host.getPlanCapabilities", { connectionId: "c1" }, "legacy");
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ id: "legacy", error: "Host plan API is unavailable" });
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
    expect(document).toContain("copy");
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

  it("injects a <base> and widens resource CSP sources for the plugin asset origin", () => {
    const document = pluginSandboxDocument("<html><head></head><body></body></html>", [], undefined, { baseUrl: "dbx-plugin://localhost/io.github.t8y2.s3/assets/" });
    expect(document).toContain('<base href="dbx-plugin://localhost/io.github.t8y2.s3/assets/">');
    expect(document).toContain("script-src 'unsafe-inline' blob: dbx-plugin:;");
    expect(document).toContain("font-src data: blob: dbx-plugin:;");
    // <base> leads the head injection so inlined CSS url() resolves against it.
    expect(document.indexOf("<base ")).toBeLessThan(document.indexOf("<style>"));
  });

  it("allows the WebView2-mapped asset origin exactly", () => {
    const document = pluginSandboxDocument("<html><head></head><body></body></html>", [], undefined, { baseUrl: "http://dbx-plugin.localhost/io.github.t8y2.s3/assets/" });
    expect(document).toContain("script-src 'unsafe-inline' blob: http://dbx-plugin.localhost;");
    expect(document).toContain('<base href="http://dbx-plugin.localhost/io.github.t8y2.s3/assets/">');
  });

  it("rejects malformed asset base URLs without touching the CSP", () => {
    const document = pluginSandboxDocument("<html><head></head><body></body></html>", [], undefined, { baseUrl: "javascript:alert(1)" });
    expect(document).not.toContain("<base ");
    expect(document).toContain("script-src 'unsafe-inline' blob:;");
  });

  it("keeps the sandbox CSP untouched without an asset base URL", () => {
    const document = pluginSandboxDocument("<html><head></head><body></body></html>");
    expect(document).toContain("script-src 'unsafe-inline' blob:;");
    expect(document).toContain("font-src data: blob:;");
    expect(document).not.toContain("<base ");
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

    // The structured editor snapshot rides along on every theme push.
    const editor = { fontFamily: "Fira Code", fontSize: 13, theme: "one-dark" };
    bridge.updateTheme({ appearance: "light", tokens: {}, editor });
    expect(messages[2]).toMatchObject({ type: "env", locale: "en", theme: { appearance: "light", tokens: {}, editor } });
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

  it("routes host.copy through the host clipboard and rejects bad payloads", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const copyText = vi.fn().mockResolvedValue(undefined);
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      copyText,
    });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "copy1", method: "host.copy", params: { text: "https://example.com/share?sig=1" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(copyText).toHaveBeenCalledWith("sample", "https://example.com/share?sig=1");
    expect(messages[0]).toMatchObject({ type: "response", id: "copy1", result: { success: true } });

    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "copy2", method: "host.copy", params: { text: "" } },
    } as MessageEvent);
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "copy3", method: "host.copy", params: { text: "x".repeat(2 * 1024 * 1024 + 1) } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    const byId = new Map(messages.map((message) => [(message as { id?: string }).id, message]));
    expect(byId.get("copy2")).toMatchObject({ id: "copy2", error: "host.copy requires text" });
    // Oversized text is stopped by the generic bridge payload guard before the handler cap.
    expect(String((byId.get("copy3") as { error?: string }).error)).toMatch(/too large|exceeds/);
  });

  it("rejects host.copy when the host has no clipboard support", async () => {
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
      data: { source: "dbx-plugin", version: 1, type: "request", id: "nocopy", method: "host.copy", params: { text: "hello" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "nocopy", error: "Host clipboard is unavailable" });
  });

  it("routes host.storage through the owning plugin, caps values, and needs the declared permission", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const storageGet = vi.fn().mockResolvedValue({ mode: "dark" });
    const storageSet = vi.fn().mockResolvedValue(undefined);
    const storageDelete = vi.fn().mockResolvedValue(undefined);
    const send = (bridge: PluginHostBridge, id: string, method: string, params: unknown) => bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id, method, params } } as MessageEvent);

    // No declared host.storage permission: every call is refused up front.
    const denied = new PluginHostBridge(plugin(), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      storageGet,
      storageSet,
      storageDelete,
    });
    send(denied, "denied", "host.storageGet", { key: "theme" });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ id: "denied", error: "Plugin has not declared permission 'host.storage'" });
    expect(storageGet).not.toHaveBeenCalled();

    const bridge = new PluginHostBridge(plugin(["host.storage"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      storageGet,
      storageSet,
      storageDelete,
    });
    bridge.sendInit();
    expect((messages[1] as { capabilities?: { storage?: boolean } }).capabilities?.storage).toBe(true);

    send(bridge, "get", "host.storageGet", { key: "theme" });
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalledWith("sample", "theme"));
    await vi.waitFor(() => expect(messages[2]).toMatchObject({ id: "get", result: { mode: "dark" } }));

    send(bridge, "set", "host.storageSet", { key: "theme", value: { mode: "light" } });
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith("sample", "theme", { mode: "light" }));
    await vi.waitFor(() => expect(messages[3]).toMatchObject({ id: "set", result: null }));

    send(bridge, "delete", "host.storageDelete", { key: "theme" });
    await vi.waitFor(() => expect(storageDelete).toHaveBeenCalledWith("sample", "theme"));

    // `undefined` values normalize to null so the entry round-trips as JSON.
    send(bridge, "nullish", "host.storageSet", { key: "empty", value: null });
    await vi.waitFor(() => expect(storageSet).toHaveBeenLastCalledWith("sample", "empty", null));

    send(bridge, "badkey", "host.storageGet", { key: "" });
    send(bridge, "bigvalue", "host.storageSet", { key: "blob", value: "x".repeat(256 * 1024 + 1) });
    await vi.waitFor(() => expect(messages).toHaveLength(8));
    const byId = new Map(messages.map((message) => [(message as { id?: string }).id, message]));
    expect(byId.get("badkey")).toMatchObject({ id: "badkey", error: "storage key is invalid" });
    expect(String((byId.get("bigvalue") as { error?: string }).error)).toMatch(/value exceeds/);
  });

  it("does not advertise or serve host.storage without the host implementation", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(["host.storage"]), workbench, {}, () => target, {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
    });
    bridge.sendInit();
    expect((messages[0] as { capabilities?: { storage?: boolean } }).capabilities?.storage).toBe(false);
    bridge.handleWindowMessage({
      source: target,
      data: { source: "dbx-plugin", version: 1, type: "request", id: "nostorage", method: "host.storageGet", params: { key: "theme" } },
    } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ id: "nostorage", error: "Host storage is unavailable" });
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
    dbxPlugin?: {
      invoke: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
      getPlanCapabilities: (connectionId: string) => Promise<unknown>;
      explainPlan: (request: unknown) => Promise<unknown>;
    };
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

  it("exposes the plan Host API to plugin UI without defaulting the mode", () => {
    const posted: unknown[] = [];
    const { dbxPlugin } = loadSdk(posted);

    void dbxPlugin!.getPlanCapabilities("c1");
    void dbxPlugin!.explainPlan({ connectionId: "c1", sql: "SELECT 1", mode: "estimated" });
    const requests = posted.filter((message) => (message as { type: string }).type === "request") as {
      method: string;
      params: Record<string, unknown>;
    }[];

    expect(requests.map((request) => request.method)).toEqual(["host.getPlanCapabilities", "host.explainPlan"]);
    expect(requests[0].params).toEqual({ connectionId: "c1" });
    // The SDK forwards the mode verbatim: defaulting it would let a plugin reach
    // a plan mode it never asked for.
    expect(requests[1].params).toEqual({ connectionId: "c1", sql: "SELECT 1", mode: "estimated" });
  });

  it("forwards fileTransfer requests to the host api", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const api = {
      invoke: vi.fn(),
      notify: vi.fn(),
      sendBinary: vi.fn(),
      readAsset: vi.fn(),
      pickFiles: vi.fn().mockResolvedValue([{ handleId: "t1", name: "a.txt", size: 1, contentType: "text/plain" }]),
      readFileChunk: vi.fn().mockResolvedValue({ dataBase64: "YQ==", length: 1, eof: true }),
      beginFileSave: vi.fn().mockResolvedValue({ handleId: "t2", chunkBytes: 4 }),
      writeFileChunk: vi.fn().mockResolvedValue({ written: 2, nextOffset: 2 }),
      finishFileSave: vi.fn().mockResolvedValue(undefined),
      closeFileHandle: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, api);

    const request = (id: string, method: string, params: unknown, data?: ArrayBuffer) => {
      bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id, method, params, data } } as MessageEvent);
    };
    request("1", "host.pickFiles", { multiple: true });
    request("2", "host.readFileChunk", { handleId: "t1", offset: 0, length: 10 });
    request("3", "host.beginFileSave", { name: "out.bin" });
    request("4", "host.writeFileChunk", { handleId: "t2", offset: 0 }, new ArrayBuffer(2));
    request("5", "host.finishFileSave", { handleId: "t2" });
    request("6", "host.closeFileHandle", { handleId: "t1" });

    await vi.waitFor(() => expect(messages.filter((message) => (message as { type?: string }).type === "response")).toHaveLength(6));
    expect(api.pickFiles).toHaveBeenCalledWith("sample", { multiple: true });
    expect(api.readFileChunk).toHaveBeenCalledWith("sample", "t1", 0, 10);
    expect(api.beginFileSave).toHaveBeenCalledWith("sample", { name: "out.bin", contentType: undefined, size: undefined });
    expect(api.writeFileChunk).toHaveBeenCalledWith("sample", "t2", 0, expect.any(Uint8Array));
    expect(api.finishFileSave).toHaveBeenCalledWith("sample", "t2");
    expect(api.closeFileHandle).toHaveBeenCalledWith("sample", "t1");
    for (const message of messages) expect((message as { error?: string }).error).toBeUndefined();
  });

  it("resolves a cancelled beginFileSave to null", async () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn(), beginFileSave: vi.fn().mockResolvedValue(null) });

    bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", id: "1", method: "host.beginFileSave", params: { name: "out.bin" } } } as MessageEvent);

    await vi.waitFor(() => expect(messages.filter((message) => (message as { type?: string }).type === "response")).toHaveLength(1));
    expect(messages[0]).toMatchObject({ type: "response", id: "1", result: null });
  });

  it("pushes drag state and opened drop handles to the plugin", () => {
    const messages: unknown[] = [];
    const target = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin(), workbench, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn() });

    bridge.forwardDragState(true);
    bridge.forwardFileDrop([{ handleId: "t1", name: "a.txt", size: 1, contentType: "text/plain" }]);

    expect(messages[0]).toMatchObject({ source: "dbx-host", version: 1, type: "dragstate", active: true });
    expect(messages[1]).toMatchObject({ source: "dbx-host", version: 1, type: "filedrop", files: [{ handleId: "t1", name: "a.txt" }] });
  });

  it("sdk exposes the fileTransfer namespace and drop listeners", () => {
    const source = pluginSdkSource();
    expect(source).toContain("fileTransfer");
    expect(source).toContain("host.pickFiles");
    expect(source).toContain("host.readFileChunk");
    expect(source).toContain("host.beginFileSave");
    expect(source).toContain("host.writeFileChunk");
    expect(source).toContain("host.finishFileSave");
    expect(source).toContain("onDrop");
    expect(source).toContain("onDragState");
    expect(source).toContain("type === 'filedrop'");
    expect(source).toContain("type === 'dragstate'");
  });
});
