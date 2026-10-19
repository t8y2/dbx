import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabDragAppearance } from "../tabDragAppearance";

const mocks = vi.hoisted(() => ({
  existing: null as any,
  options: null as any,
  events: new Map<string, (...args: any[]) => any>(),
  ready: null as any,
  emitTo: vi.fn(async () => {}),
  stopReady: vi.fn(),
  setSize: vi.fn(async () => {}),
  setPosition: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: async (_event: string, handler: any) => {
      mocks.ready = handler;
      return mocks.stopReady;
    },
  }),
  WebviewWindow: class {
    constructor(_label: string, options: any) {
      mocks.options = options;
      mocks.existing = this;
    }
    static async getByLabel() {
      return mocks.existing;
    }
    once(name: string, callback: any) {
      mocks.events.set(name, callback);
      return Promise.resolve(() => {});
    }
    setSize = mocks.setSize;
    setPosition = mocks.setPosition;
    destroy = mocks.destroy;
    async setIgnoreCursorEvents() {}
    async setAlwaysOnTop() {}
  },
}));

const appearance: TabDragAppearance = { width: 240, height: 36, grabX: 80, grabY: 17, pixelRatio: 1.5, style: {}, parts: [{ style: {}, text: "SQL" }] };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { href: "http://localhost/?dbxWorkspace=child" } });
  mocks.existing = null;
  mocks.events.clear();
});

describe("native tab preview host", () => {
  it("waits for the preview listener and sends a snapshot once, not on every mouse move", async () => {
    const host = await import("../tabWindowPreviewHost");
    await host.showTabDragPreviewWebview(appearance, { x: 700, y: 300 });
    expect(new URL(mocks.options.url).searchParams.get("source")).toBe("main");
    expect(new URL(mocks.options.url).searchParams.has("dbxWorkspace")).toBe(false);
    expect(mocks.options.visible).toBe(false);
    await mocks.events.get("tauri://created")!();
    expect(mocks.emitTo).not.toHaveBeenCalled();
    mocks.ready({ payload: { label: host.TAB_DRAG_PREVIEW_WEBVIEW_LABEL } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledOnce());
    expect(mocks.emitTo).toHaveBeenCalledWith({ kind: "WebviewWindow", label: host.TAB_DRAG_PREVIEW_WEBVIEW_LABEL }, host.TAB_DRAG_PREVIEW_CONTENT_EVENT, appearance);
    expect(mocks.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 384, height: 78 }));
    await host.showTabDragPreviewWebview(appearance, { x: 800, y: 400 });
    expect(mocks.emitTo).toHaveBeenCalledOnce();
    expect(mocks.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 668, y: 363 }));
    await host.hideTabDragPreviewWebview();
    expect(mocks.stopReady).toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("does not resurrect a preview whose creation finishes after dragging ended", async () => {
    const host = await import("../tabWindowPreviewHost");
    await host.showTabDragPreviewWebview(appearance, { x: 700, y: 300 });
    await host.hideTabDragPreviewWebview();
    await mocks.events.get("tauri://created")!();
    mocks.ready({ payload: { label: host.TAB_DRAG_PREVIEW_WEBVIEW_LABEL } });
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
});
