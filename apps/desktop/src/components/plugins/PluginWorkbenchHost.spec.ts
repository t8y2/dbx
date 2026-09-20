// @vitest-environment happy-dom

import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const mocks = vi.hoisted(() => ({
  readPluginUiEntry: vi.fn(),
  readPluginUiAsset: vi.fn(),
  subscribePluginEvents: vi.fn(),
  repushPluginConnection: vi.fn(),
  reopenPluginConnection: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePlugin: vi.fn(),
  notifyPlugin: vi.fn(),
  sendPluginBinary: vi.fn(),
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
    repushPluginConnection: mocks.repushPluginConnection,
    reopenPluginConnection: mocks.reopenPluginConnection,
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ locale: ref("en"), t: (key: string) => key }) }));

import PluginWorkbenchHost from "./PluginWorkbenchHost.vue";

const plugin: InstalledPlugin = {
  manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions: [], drivers: [], contributions: [] },
  compatibility: { compatible: true },
};
const contribution: PluginWorkbenchContribution = { type: "workbench", id: "sample.main", label: "Sample" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushWorkbenchLoad() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe("PluginWorkbenchHost initialization", () => {
  let app: App<Element> | undefined;
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("getComputedStyle", () => Object.assign([], { getPropertyValue: () => "" }));
    mocks.readPluginUiEntry.mockResolvedValue({ dataBase64: btoa("<!doctype html><html><body></body></html>"), contentType: "text/html" });
    mocks.subscribePluginEvents.mockResolvedValue(vi.fn());
    mocks.repushPluginConnection.mockReset().mockResolvedValue(undefined);
    mocks.reopenPluginConnection.mockResolvedValue(undefined);
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    app?.unmount();
    root.remove();
    vi.unstubAllGlobals();
  });

  async function mountHost() {
    app = createApp(PluginWorkbenchHost, { plugin, contribution, context: { connectionId: "connection" } });
    app.mount(root);
    await flushWorkbenchLoad();
    const frame = root.querySelector("iframe");
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    const target = frame!.contentWindow!;
    const postMessage = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    const ready = () => window.dispatchEvent(new MessageEvent("message", { source: target, data: { source: "dbx-plugin", version: 1, type: "ready" } }));
    ready();
    await vi.waitFor(() => expect(mocks.repushPluginConnection).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.repushPluginConnection.mockClear();
    postMessage.mockClear();
    return { frame: frame!, postMessage, ready };
  }

  it("runs reinit before one init when load precedes ready", async () => {
    const firstReinit = deferred();
    const { frame, postMessage, ready } = await mountHost();
    mocks.repushPluginConnection.mockReturnValue(firstReinit.promise);

    frame.dispatchEvent(new Event("load"));
    ready();

    expect(mocks.repushPluginConnection).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    firstReinit.resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "init" });

    const secondReinit = deferred();
    mocks.repushPluginConnection.mockReturnValue(secondReinit.promise);
    frame.dispatchEvent(new Event("load"));
    ready();

    expect(mocks.repushPluginConnection).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(1);
    secondReinit.resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
  });

  it("runs reinit before one init when ready precedes load", async () => {
    const reinit = deferred();
    const { frame, postMessage, ready } = await mountHost();
    mocks.repushPluginConnection.mockReturnValue(reinit.promise);

    ready();
    frame.dispatchEvent(new Event("load"));

    expect(mocks.repushPluginConnection).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    reinit.resolve();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "init" });
  });
});
