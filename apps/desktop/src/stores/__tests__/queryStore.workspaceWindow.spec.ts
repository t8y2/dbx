import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/app/windowContext", () => ({
  isWorkspaceWindow: () => true,
  isDetachedWindow: () => false,
  resolveWindowContext: () => ({ kind: "workspace", windowLabel: "dbx-tab-test" }),
}));
vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
  loadOpenTabsState: mocks.load,
  saveOpenTabsState: mocks.save,
}));

describe("queryStore workspace window isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.load.mockReset().mockResolvedValue(null);
    mocks.save.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal("window", { dispatchEvent: vi.fn(), setTimeout: vi.fn(() => 0), clearTimeout: vi.fn() });
    setActivePinia(createPinia());
  });

  it("starts empty rather than restoring main's legacy tabs", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    await store.initOpenTabs();
    expect(store.tabs).toHaveLength(0);
    expect(localStorage.getItem).not.toHaveBeenCalledWith("dbx-open-tabs");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("restores its own live window even when app restart restoration is disabled", async () => {
    const { useSettingsStore } = await import("../settingsStore");
    useSettingsStore().editorSettings.openTabsRestoreMode = "none";
    mocks.load.mockResolvedValue({ tabs: [{ id: "child-tab", title: "SQL", connectionId: "c", database: "db", mode: "query", sql: "select 1" }], activeTabId: "child-tab" });
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    await store.initOpenTabs();
    expect(store.tabs.map((tab) => tab.id)).toEqual(["child-tab"]);
    expect(store.groups[0]?.tabIds).toEqual(["child-tab"]);
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it("does not overwrite a snapshot when loading it fails", async () => {
    mocks.load.mockRejectedValue(new Error("disk unavailable"));
    const { useQueryStore } = await import("../queryStore");
    await expect(useQueryStore().initOpenTabs()).rejects.toThrow("disk unavailable");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("extends workspace handoffs without relaxing upstream single-tab restrictions", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const id = store.openTableStructure("c", "db", undefined, "users");
    await expect(store.prepareDetachedTab(id)).rejects.toThrow("Only SQL and data tabs");
    const handoff = await store.prepareDetachedTab(id, {}, { workspace: true });
    expect(handoff.tabId).toBe(id);
    expect(handoff.sourceWindowLabel).toBe("dbx-tab-test");
  });

  it("keeps uncommitted grid edits in their original window", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const id = store.createTab("c", "db", "SQL", "query");
    store.tabs[0]!.pendingDataChangeCount = 1;
    await expect(store.prepareDetachedTab(id, {}, { workspace: true })).rejects.toThrow("pending data edits");
    expect(store.tabs[0]?.id).toBe(id);
  });
});
