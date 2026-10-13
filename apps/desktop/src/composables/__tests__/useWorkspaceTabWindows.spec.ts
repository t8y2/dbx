// @vitest-environment happy-dom
import { createApp, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: { kind: "main", windowLabel: "main" },
  settings: { editorSettings: { crossWindowTabDragPreviewEnabled: true, tabPlacement: "top" } },
  tabs: [] as Array<{ id: string; title: string }>,
  listeners: new Map<string, (message: { payload: any }) => void>(),
  calls: [] as string[],
  invoke: vi.fn(),
  toast: vi.fn(),
  persist: vi.fn(),
  emitTo: vi.fn(),
  eventListen: vi.fn(),
  dropHit: null as { groupId: string; index?: number; tabId?: string } | null,
  cursor: { x: 950, y: 300 },
  show: vi.fn(),
  focus: vi.fn(),
  release: vi.fn(),
  unlock: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/app/windowContext", () => ({ resolveWindowContext: () => ({ ...mocks.context }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/common/utils", () => ({ uuid: () => "transfer-1" }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    tabs: mocks.tabs,
    groups: [{ id: "main", tabIds: [] }],
    focusedGroupId: "main",
    prepareDetachedTab: async (id: string) => {
      mocks.calls.push("prepare");
      return { schemaVersion: 1, tabId: id, tab: { id, title: id }, runtime: {} };
    },
    adoptDetachedTab: async (handoff: { tabId: string }) => {
      mocks.calls.push("adopt");
      mocks.tabs.push({ id: handoff.tabId, title: handoff.tabId });
    },
    moveTabToGroup: () => {
      mocks.calls.push("move-group");
    },
    removeTabAfterDetachedReady: (id: string) => {
      mocks.calls.push("remove");
      const index = mocks.tabs.findIndex((tab) => tab.id === id);
      if (index >= 0) mocks.tabs.splice(index, 1);
    },
    flushPendingPersist: mocks.persist,
  }),
}));
vi.mock("@/lib/app/updatePreparation", () => ({
  beginUpdateSensitiveOperation: () => mocks.release,
  acquireUpdateBarrier: () => mocks.unlock,
  assertUpdateSafe: () => {},
}));
vi.mock("@/lib/tabs/tabWindowPreviewHost", () => ({ showTabDragPreviewWebview: vi.fn(), hideTabDragPreviewWebview: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo, emit: vi.fn(async () => {}), listen: mocks.eventListen }));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: async () => mocks.cursor,
  getCurrentWindow: () => ({ innerPosition: async () => (mocks.context.windowLabel === "main" ? { x: 0, y: 0 } : { x: 800, y: 0 }), scaleFactor: async () => 1 }),
  monitorFromPoint: async () => ({ scaleFactor: 1 }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, options: unknown) {
      mocks.create(label, options);
    }
    async once(name: string, handler: () => void) {
      if (name === "tauri://created") handler();
      return () => {};
    }
    destroy = mocks.destroy;
    static async getByLabel() {
      return { destroy: mocks.destroy };
    }
  },
  getAllWebviewWindows: async () => [
    { label: "main", title: async () => "DBX", outerPosition: async () => ({ x: 0, y: 0 }), outerSize: async () => ({ width: 800, height: 600 }), isVisible: async () => true, isMinimized: async () => false, isFocused: async () => false },
    { label: "dbx-tab-child", title: async () => "child", outerPosition: async () => ({ x: 800, y: 0 }), outerSize: async () => ({ width: 800, height: 600 }), isVisible: async () => true, isMinimized: async () => false, isFocused: async () => true },
    { label: "dbx-tab-drag-preview", title: async () => "preview" },
    { label: "plugin-floating-one", title: async () => "plugin" },
    { label: "detached-tab-one", title: async () => "detached" },
  ],
  getCurrentWebviewWindow: () => ({
    label: mocks.context.windowLabel,
    show: mocks.show,
    setFocus: mocks.focus,
    listen: async (name: string, handler: (message: { payload: any }) => void) => {
      mocks.listeners.set(name, handler);
      return () => {
        mocks.listeners.delete(name);
      };
    },
  }),
}));

import { useWorkspaceTabWindows } from "../useWorkspaceTabWindows";

describe("useWorkspaceTabWindows", () => {
  let unmount: (() => void) | undefined;
  const requestClose = vi.fn();
  const assertCloseSafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context = { kind: "main", windowLabel: "main" };
    mocks.settings.editorSettings.crossWindowTabDragPreviewEnabled = true;
    mocks.tabs.length = 0;
    mocks.calls.length = 0;
    mocks.listeners.clear();
    mocks.dropHit = null;
    mocks.cursor = { x: 950, y: 300 };
    mocks.eventListen.mockImplementation(async (name: string, handler: (message: { payload: any }) => void) => {
      mocks.listeners.set(name, handler);
      return () => mocks.listeners.delete(name);
    });
    mocks.emitTo.mockImplementation(async (_destination: unknown, event: string, payload: any) => {
      if (event === "dbx:workspace-tab-drop-hit-test") {
        mocks.listeners.get("dbx:workspace-tab-drop-hit-test-result")?.({ payload: { id: payload.id, target: payload.target, ready: true, drop: mocks.dropHit } });
      }
    });
    window.history.replaceState(null, "", "/");
    mocks.persist.mockImplementation(async () => {
      mocks.calls.push("persist");
    });
    mocks.invoke.mockImplementation(async (_command: string, args: { operation?: string }) => {
      if (args.operation === "read") return { schemaVersion: 1, tabId: "incoming", tab: { id: "incoming" }, runtime: {} };
      if (args.operation === "status" || args.operation === "commit") {
        mocks.calls.push("committed");
        return "committed";
      }
      if (args.operation === "cancel" || args.operation === "reject") return "cancelled";
      return "pending";
    });
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  async function mount() {
    let service!: ReturnType<typeof useWorkspaceTabWindows>;
    const app = createApp({
      setup() {
        service = useWorkspaceTabWindows({ requestClose, assertCloseSafe });
        return () => h("div");
      },
    });
    app.mount(document.createElement("div"));
    unmount = () => app.unmount();
    await service.setup();
    return service;
  }

  it("lists only compatible workspace targets", async () => {
    const service = await mount();
    await service.refreshTargets();
    expect(service.targets.value.map((target) => target.label)).toEqual(["dbx-tab-child"]);
  });

  it("removes the source only after the target committed", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    await service.moveTab(tab as any, "dbx-tab-child");
    expect(mocks.calls).toEqual(["prepare", "committed", "remove", "persist"]);
    expect(mocks.tabs).toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalledWith("complete_app_close", expect.anything());
  });

  it("keeps the source after target cancellation", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    mocks.invoke.mockImplementation(async (_command, args) => (args.operation === "offer" ? "pending" : "cancelled"));
    await service.moveTab(tab as any, "dbx-tab-child");
    expect(mocks.tabs).toEqual([tab]);
    expect(mocks.calls).not.toContain("remove");
    expect(mocks.toast).toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("shows new windows immediately without removing the source before confirmation", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    mocks.invoke.mockImplementation(async (_command, args) => (args.operation === "offer" ? "pending" : "cancelled"));
    await service.moveTab(tab as any);
    expect(mocks.create).toHaveBeenCalledWith("dbx-tab-transfer-1", expect.objectContaining({ visible: true }));
    expect(mocks.tabs).toEqual([tab]);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("creates a new window when released over an existing window outside its tab bar", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    expect(service.finishPointerDrag(tab as any, { clientX: -1, clientY: 300 } as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledWith("dbx-tab-transfer-1", expect.objectContaining({ visible: true })));
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", expect.objectContaining({ operation: "offer", target: "dbx-tab-transfer-1" }));
    expect(mocks.tabs).toHaveLength(0);
  });

  it("creates a new window when released in the source window outside its tab bar", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    mocks.cursor = { x: 600, y: 300 };
    expect(service.finishPointerDrag(tab as any, { clientX: 600, clientY: 300 } as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledWith("dbx-tab-transfer-1", expect.objectContaining({ visible: true })));
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", expect.objectContaining({ operation: "offer", target: "dbx-tab-transfer-1" }));
  });

  it("transfers into the existing window only when its tab bar confirms a hit", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    mocks.dropHit = { groupId: "main", index: 0 };
    expect(service.finishPointerDrag(tab as any, { clientX: -1, clientY: 300 } as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", expect.objectContaining({ operation: "offer", target: "dbx-tab-child" })));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not create a window when the existing target cannot confirm the drop", async () => {
    const service = await mount();
    const tab = { id: "source", title: "SQL" };
    mocks.tabs.push(tab);
    mocks.emitTo.mockImplementation(async (_destination: unknown, event: string) => {
      if (event === "dbx:workspace-tab-drop-hit-test") {
        mocks.listeners.get("dbx:workspace-tab-drop-hit-test-result")?.({ payload: { id: "transfer-1", target: "dbx-tab-child", ready: false, drop: null } });
      }
    });
    expect(service.finishPointerDrag(tab as any, { clientX: -1, clientY: 300 } as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("workspaceDropTargetUnavailable"), 7000));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("workspace_tab_transfer", expect.objectContaining({ operation: "offer" }));
    expect(mocks.tabs).toEqual([tab]);
  });

  it("keeps a cancelled startup window available for retry or close", async () => {
    mocks.context = { kind: "workspace", windowLabel: "dbx-tab-transfer-1" };
    window.history.replaceState(null, "", "/?dbxWorkspace=transfer-1&dbxWorkspaceTransfer=transfer-1");
    mocks.invoke.mockResolvedValue(null);
    await mount();
    expect(mocks.invoke).not.toHaveBeenCalledWith("complete_workspace_window_close");
    expect(window.location.search).toContain("dbxWorkspaceTransfer");
  });

  it("retries from the current source tab using a fresh offer rather than the old payload", async () => {
    await mount();
    mocks.tabs.push({ id: "source", title: "edited SQL" });
    mocks.invoke.mockImplementation(async (_command, args) => {
      if (args.operation === "inspect") return { source: "main", target: "dbx-tab-failed", tabId: "source", status: "cancelled" };
      return args.operation === "offer" ? "pending" : "committed";
    });
    mocks.listeners.get("dbx:workspace-tab-retry")!({ payload: { id: "old-transfer" } });
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.calls).toContain("prepare");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", expect.objectContaining({ operation: "offer", id: "transfer-1" }));
  });

  it("does not transfer when the preview setting is disabled", async () => {
    const service = await mount();
    mocks.settings.editorSettings.crossWindowTabDragPreviewEnabled = false;
    // 本测试的设置对象非响应式，先构造禁用状态下的新实例。
    unmount?.();
    const disabled = await mount();
    await disabled.moveTab({ id: "source", title: "SQL" } as any, "dbx-tab-child");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(service.targets.value).toHaveLength(0);
  });

  it("adopts into a group, persists, then acknowledges the target", async () => {
    await mount();
    mocks.listeners.get("dbx:workspace-tab-transfer")!({ payload: { id: "transfer-1", target: "main" } });
    await vi.waitFor(() => expect(mocks.show).toHaveBeenCalled());
    expect(mocks.calls).toEqual(["adopt", "move-group", "persist", "committed"]);
    expect(mocks.tabs[0]?.id).toBe("incoming");
  });

  it("ignores transfer events targeting another window", async () => {
    await mount();
    mocks.listeners.get("dbx:workspace-tab-transfer")!({ payload: { id: "transfer-1", target: "dbx-tab-other" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects disabled targets immediately without adopting", async () => {
    mocks.settings.editorSettings.crossWindowTabDragPreviewEnabled = false;
    await mount();
    mocks.listeners.get("dbx:workspace-tab-transfer")!({ payload: { id: "transfer-1", target: "main" } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", { operation: "reject", id: "transfer-1" }));
    expect(mocks.calls).not.toContain("adopt");
  });

  it("routes child close locally without assigning a new main", async () => {
    mocks.context = { kind: "workspace", windowLabel: "dbx-tab-child" };
    await mount();
    mocks.listeners.get("dbx-workspace-close-requested")!({ payload: "main" });
    expect(requestClose).not.toHaveBeenCalled();
    mocks.listeners.get("dbx-workspace-close-requested")!({ payload: "dbx-tab-child" });
    expect(requestClose).toHaveBeenCalledOnce();
    expect(mocks.context.windowLabel).toBe("dbx-tab-child");
  });

  it("flushes child drafts before acknowledging main's quit", async () => {
    mocks.context = { kind: "workspace", windowLabel: "dbx-tab-child" };
    await mount();
    mocks.listeners.get("dbx:workspace-close-prepare")!({ payload: { id: "quit-1", targets: ["dbx-tab-child"] } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx:workspace-close-ready", { id: "quit-1", label: "dbx-tab-child", error: undefined }));
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.unlock).not.toHaveBeenCalled();
    mocks.listeners.get("dbx:workspace-close-release")!({ payload: { id: "quit-1" } });
    expect(mocks.unlock).toHaveBeenCalledOnce();
  });
});
