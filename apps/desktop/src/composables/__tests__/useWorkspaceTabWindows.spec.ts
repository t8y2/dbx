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
  show: vi.fn(),
  focus: vi.fn(),
  release: vi.fn(),
  unlock: vi.fn(),
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
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo, emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: async () => [
    { label: "main", title: async () => "DBX" },
    { label: "dbx-tab-child", title: async () => "child" },
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
