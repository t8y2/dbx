// @vitest-environment happy-dom

import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  ensureConnected: vi.fn(),
  repushPluginConnection: vi.fn(),
  connectedIds: new Set<string>(["conn-1"]),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePlugin: vi.fn(),
  notifyPlugin: vi.fn(),
  sendPluginBinary: vi.fn(),
  listPlugins: mocks.listPlugins,
  readPluginUiEntry: vi.fn(),
  readPluginUiAsset: vi.fn(),
  subscribePluginEvents: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connectedIds: mocks.connectedIds,
    getConfig: () => undefined,
    ensureConnected: mocks.ensureConnected,
    repushPluginConnection: mocks.repushPluginConnection,
  }),
}));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ locale: ref("en"), t: (key: string) => key }),
}));

import PluginFilesystemTab from "./PluginFilesystemTab.vue";

describe("PluginFilesystemTab restore self-heal", () => {
  let app: App<Element> | undefined;
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPlugins.mockResolvedValue([]);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.repushPluginConnection.mockResolvedValue(undefined);
    mocks.connectedIds.clear();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    app?.unmount();
    root.remove();
  });

  async function mountTab() {
    app = createApp(PluginFilesystemTab, { pluginId: "io.dbx.files", providerId: "files.main", connectionId: "conn-1" });
    app.mount(root);
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }

  it("self-heals a restored tab: silent ensureConnected instead of the reload prompt", async () => {
    await mountTab();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("conn-1", { allowPasswordPrompt: false });
    expect(root.textContent).not.toContain("pluginPlatform.reloadRequired");
  });

  it("re-pushes credentials for an open connection when refreshed", async () => {
    mocks.connectedIds.add("conn-1");
    await mountTab();
    expect(mocks.repushPluginConnection).not.toHaveBeenCalled();

    const exposed = (app as unknown as { _instance?: { exposed?: Record<string, () => unknown> } })._instance?.exposed;
    await exposed?.refresh?.();
    expect(mocks.repushPluginConnection).toHaveBeenCalledWith("conn-1", { ignoreRecentHealthCheck: false });
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
  });

  it("parks on the reload prompt when silent recovery fails", async () => {
    mocks.ensureConnected.mockRejectedValue(new Error("interactive password required"));
    await mountTab();

    expect(root.textContent).toContain("pluginPlatform.reloadRequired");
  });
});
