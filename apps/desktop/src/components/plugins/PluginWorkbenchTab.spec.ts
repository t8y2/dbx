// @vitest-environment happy-dom

import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  readPluginUiEntry: vi.fn(),
  readPluginUiAsset: vi.fn(),
  subscribePluginEvents: vi.fn(),
  repushPluginConnection: vi.fn(),
  ensureConnected: vi.fn(),
  openPluginWorkbench: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePlugin: vi.fn(),
  notifyPlugin: vi.fn(),
  sendPluginBinary: vi.fn(),
  listPlugins: mocks.listPlugins,
  readPluginUiEntry: mocks.readPluginUiEntry,
  readPluginUiAsset: mocks.readPluginUiAsset,
  subscribePluginEvents: mocks.subscribePluginEvents,
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false), themeRevision: ref(0) }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { uiFontFamily: "", fontFamily: "", fontSize: 14 } }) }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connectedIds: new Set(["conn-1"]),
    getConfig: () => undefined,
    ensureConnected: mocks.ensureConnected,
    repushPluginConnection: mocks.repushPluginConnection,
    reopenPluginConnection: vi.fn(),
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openPluginWorkbench: mocks.openPluginWorkbench }) }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ locale: ref("en"), t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}));

import PluginWorkbenchTab from "./PluginWorkbenchTab.vue";

const plugin: InstalledPlugin = {
  manifest: {
    id: "com.example.graph",
    name: "Graph plugin",
    version: "1.0.0",
    permissions: [],
    drivers: [],
    entrypoints: { ui: { root: "ui", entry: "ui/index.html" } },
    contributions: [
      { type: "workbench", id: "graph.main", label: "Graph workbench" },
      { type: "result-view", id: "graph.chart", label: "Chart" },
      { type: "context-menu", id: "graph.inspect", label: "Inspect", menu: "connection" },
    ],
  },
  compatibility: { compatible: true },
};

/** The bounded snapshot `ContentArea.openPluginResultView` hands to the plugin UI. */
const resultContext = {
  connectionId: "conn-1",
  database: "dbx_test",
  sql: "SELECT id, name FROM dbx_9597_orders",
  result: { columns: ["id", "name"], rows: [[1, "alpha"]], truncated: false },
};

describe("PluginWorkbenchTab contribution resolution", () => {
  let app: App<Element> | undefined;
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("getComputedStyle", () => Object.assign([], { getPropertyValue: () => "" }));
    mocks.listPlugins.mockResolvedValue([plugin]);
    mocks.readPluginUiEntry.mockResolvedValue({ dataBase64: btoa("<!doctype html><html><body></body></html>"), contentType: "text/html" });
    mocks.subscribePluginEvents.mockResolvedValue(vi.fn());
    mocks.repushPluginConnection.mockResolvedValue(undefined);
    mocks.ensureConnected.mockResolvedValue(undefined);
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    app?.unmount();
    root.remove();
    vi.unstubAllGlobals();
  });

  async function mountTab(contributionId: string, context?: Record<string, unknown>) {
    app = createApp(PluginWorkbenchTab, { pluginId: "com.example.graph", contributionId, connectionId: "conn-1", context });
    app.mount(root);
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }

  /** Mount, reveal the sandbox iframe, and capture the bridge init payload. */
  async function mountLoadedTab(contributionId: string, context?: Record<string, unknown>) {
    await mountTab(contributionId, context);
    const frame = root.querySelector("iframe");
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    const target = frame!.contentWindow!;
    const postMessage = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    frame!.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    return postMessage;
  }

  function initPayload(postMessage: { mock: { calls: unknown[][] } }) {
    const init = postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>).find((message) => message.type === "init");
    expect(init).toBeDefined();
    return init!;
  }

  it("renders a declared result-view instead of reporting it unavailable", async () => {
    const postMessage = await mountLoadedTab("graph.chart", resultContext);

    // The regression behind #9597: the toolbar opens the tab with the
    // result-view contribution id, which a workbench-only lookup never resolves.
    expect(root.textContent).not.toContain("pluginPlatform.workbenchUnavailable");
    expect(initPayload(postMessage)).toMatchObject({ type: "init", pluginId: "com.example.graph", contributionId: "graph.chart" });
  });

  it("delivers the query result snapshot to a result-view plugin UI", async () => {
    const postMessage = await mountLoadedTab("graph.chart", resultContext);

    expect(initPayload(postMessage).context).toEqual(resultContext);
  });

  it("still renders a declared workbench", async () => {
    const postMessage = await mountLoadedTab("graph.main");

    expect(root.textContent).not.toContain("pluginPlatform.workbenchUnavailable");
    expect(initPayload(postMessage)).toMatchObject({ contributionId: "graph.main" });
  });

  it("reports an unavailable contribution when the id matches no renderable plugin UI", async () => {
    await mountTab("graph.missing");

    expect(root.querySelector("iframe")).toBeNull();
    expect(root.textContent).toContain("pluginPlatform.workbenchUnavailable");

    // A declared contribution that owns another host surface stays unavailable
    // here: resolving plugin UI must not turn the lookup into a wildcard.
    app?.unmount();
    await mountTab("graph.inspect");

    expect(root.querySelector("iframe")).toBeNull();
    expect(root.textContent).toContain("pluginPlatform.workbenchUnavailable");
  });
});
