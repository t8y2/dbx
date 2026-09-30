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
  openDroppedPluginLocalFiles: vi.fn(),
  readPluginLocalFileChunk: vi.fn(),
  writePluginLocalFileChunk: vi.fn(),
  closePluginLocalFile: vi.fn(),
  openPluginWorkbench: vi.fn(),
}));

vi.mock("@/lib/backend/tauri", () => ({
  openDroppedPluginLocalFiles: mocks.openDroppedPluginLocalFiles,
  readPluginLocalFileChunk: mocks.readPluginLocalFileChunk,
  writePluginLocalFileChunk: mocks.writePluginLocalFileChunk,
  closePluginLocalFile: mocks.closePluginLocalFile,
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
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openPluginWorkbench: mocks.openPluginWorkbench }) }));
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
    mocks.closePluginLocalFile.mockResolvedValue(undefined);
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

  it("claims OS drops over its iframe and forwards opened handles to the plugin", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    // The Rust registry hands out uuid strings; the `t` prefix stays opaque.
    mocks.openDroppedPluginLocalFiles.mockResolvedValue({ dropId: "drop-0001", truncated: false, files: [{ handleId: "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81", name: "a.txt", size: 3, contentType: "text/plain", write: false }] });

    const claimed = !document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/a.txt"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );

    expect(claimed).toBe(true);
    await vi.waitFor(() => {
      const posted = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
      expect(posted.some((message) => message.type === "filedrop" && (message.files as Array<Record<string, unknown>>)?.some((file) => file.handleId === "t0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81" && file.name === "a.txt"))).toBe(true);
    });
    expect(mocks.openDroppedPluginLocalFiles).toHaveBeenCalledWith("sample", ["/tmp/a.txt"]);
    elementFromPoint.mockRestore();
  });

  it("forwards a dropped folder as the files the Rust side expanded it to", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    mocks.openDroppedPluginLocalFiles.mockResolvedValue({
      dropId: "drop-0002",
      truncated: true,
      files: [
        { handleId: "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81", name: "a.txt", size: 1, contentType: "text/plain", write: false, relativePath: "folder/a.txt" },
        { handleId: "1d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81", name: "nested.csv", size: 2, contentType: "text/csv", write: false, relativePath: "folder/nested/nested.csv" },
      ],
    });

    document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/folder"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      const posted = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
      const filedrop = posted.find((message) => message.type === "filedrop");
      expect((filedrop?.files as Array<Record<string, unknown>>)?.map((file) => file.relativePath)).toEqual(["folder/a.txt", "folder/nested/nested.csv"]);
      expect(filedrop?.dropId).toBe("drop-0002");
      expect(filedrop?.truncated).toBe(true);
    });
    expect(mocks.openDroppedPluginLocalFiles).toHaveBeenCalledWith("sample", ["/tmp/folder"]);
    elementFromPoint.mockRestore();
  });

  it("does not forward a filedrop when no dropped path could be opened", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.openDroppedPluginLocalFiles.mockResolvedValue({ dropId: "drop-0003", truncated: false, files: [] });

    const claimed = !document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/gone"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );

    expect(claimed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postMessage.mock.calls.some(([message]) => (message as Record<string, unknown>).type === "filedrop")).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    elementFromPoint.mockRestore();
  });

  it("sweeps opened drop entries when the workbench unmounts", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    mocks.openDroppedPluginLocalFiles.mockResolvedValue({ dropId: "drop-0004", truncated: false, files: [{ handleId: "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81", name: "a.txt", size: 1, contentType: "text/plain", write: false }] });
    document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/a.txt"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([message]) => (message as Record<string, unknown>).type === "filedrop")).toBe(true));

    app?.unmount();
    app = undefined;
    // Teardown closes exactly the handles this instance opened — never an
    // owner-wide sweep, which would kill a sibling workbench's handles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.closePluginLocalFile).toHaveBeenCalledWith("sample", "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81");
    elementFromPoint.mockRestore();
  });

  it("retires an in-flight drop whose expansion lands after unmount", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    let resolveOpen!: (result: unknown) => void;
    mocks.openDroppedPluginLocalFiles.mockReturnValue(new Promise((resolve) => (resolveOpen = resolve)));

    document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/folder"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );
    // The expansion is still in flight when the workbench tears down.
    app?.unmount();
    app = undefined;
    resolveOpen({ dropId: "drop-late", truncated: false, files: [{ handleId: "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81", name: "late.txt", size: 1, contentType: "text/plain", write: false }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.closePluginLocalFile).toHaveBeenCalledWith("sample", "0d9f6d26-9e0e-4b1f-8f9a-2b6d3c5a7e81");
    expect(postMessage.mock.calls.some(([message]) => (message as Record<string, unknown>).type === "filedrop")).toBe(false);
    elementFromPoint.mockRestore();
  });

  it("leaves drops outside the iframe to the host fallback", async () => {
    const { postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body);

    const claimed = !document.dispatchEvent(
      new CustomEvent("dbx:tauri-file-drop", {
        detail: { type: "drop", paths: ["/tmp/a.txt"], position: { x: 200, y: 200 } },
        cancelable: true,
      }),
    );

    expect(claimed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postMessage).not.toHaveBeenCalled();
    expect(mocks.openDroppedPluginLocalFiles).not.toHaveBeenCalled();
    elementFromPoint.mockRestore();
  });

  it("reports drag enter/leave state while the pointer is over the iframe", async () => {
    const { frame, postMessage } = await mountHost();
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(frame);
    const payload = (type: "enter" | "leave") => new CustomEvent("dbx:tauri-file-drop", { detail: { type, position: { x: 10, y: 10 } }, cancelable: true });

    document.dispatchEvent(payload("enter"));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "dragstate", active: true }), "*");

    document.dispatchEvent(payload("leave"));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "dragstate", active: false }), "*");
    elementFromPoint.mockRestore();
  });
});
