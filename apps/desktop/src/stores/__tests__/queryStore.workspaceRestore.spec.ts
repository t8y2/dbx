import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => {}),
  legacySave: vi.fn(async () => {}),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/app/workspaceWindows", () => ({
  loadWorkspaceWindow: mocks.load,
  saveWorkspaceWindow: mocks.save,
  listWorkspaceWindows: async () => [{ windowLabel: "dbx-tab-restored" }],
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveOpenTabsState: mocks.legacySave,
  listDetachedTabHandoffs: async () => [],
}));

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("window", {
    location: { search: "?dbxWorkspaceWindow=dbx-tab-restored" },
    dispatchEvent: vi.fn(),
    setTimeout: () => 0,
    clearTimeout: vi.fn(),
  });
  setActivePinia(createPinia());
  mocks.load.mockResolvedValue({
    tabs: [
      { id: "first", title: "First", sql: "SELECT 1;", originalSql: "SELECT 1;", connectionId: "conn", database: "db" },
      { id: "second", title: "Second", sql: "SELECT 2;", originalSql: "", connectionId: "conn", database: "db" },
    ],
    activeTabId: "second",
    groups: [
      { id: "left", tabIds: ["first"], activeTabId: "first" },
      { id: "right", tabIds: ["second"], activeTabId: "second" },
    ],
    focusedGroupId: "right",
    orientation: "horizontal",
    sizes: [40, 60],
  });
});

describe("queryStore workspace session restoration", () => {
  it.each(["none", "pinned"] as const)("restores the full child workspace when ordinary tab restoration is %s", async (mode) => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.openTabsRestoreMode = mode;
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs();
    expect(store.tabs.map((tab) => tab.sql)).toEqual(["SELECT 1;", "SELECT 2;"]);
    expect(store.activeTabId).toBe("second");
    expect(store.groups.map((group) => group.tabIds)).toEqual([["first"], ["second"]]);
    expect(store.orientation).toBe("horizontal");
    expect(store.sizes).toEqual([40, 60]);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ focusedGroupId: "right", sizes: [40, 60] }));
    expect(mocks.legacySave).not.toHaveBeenCalled();
  });

  it("continues honoring disabled ordinary tab restoration in the main window", async () => {
    vi.stubGlobal("window", { location: { search: "" }, dispatchEvent: vi.fn(), setTimeout: () => 0, clearTimeout: vi.fn() });
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.openTabsRestoreMode = "none";
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs();
    expect(store.tabs).toHaveLength(0);
    expect(mocks.legacySave).toHaveBeenCalledWith(expect.objectContaining({ tabs: [] }));
  });
});
