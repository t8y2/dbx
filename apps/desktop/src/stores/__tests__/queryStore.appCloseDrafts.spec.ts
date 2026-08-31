import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finishAppCloseWithRequiredPersist } from "@/lib/app/appClosePersistence";

const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

describe("queryStore app close unsaved drafts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.saveOpenTabsState.mockReset();
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  async function createStoreWithDirtyQueryTab() {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("conn-1", "db");
    queryStore.updateSql(tabId, "select 1;");
    return { queryStore, tabId };
  }

  async function createDirtyStructureTab(queryStore: Awaited<ReturnType<typeof createStoreWithDirtyQueryTab>>["queryStore"]) {
    const tabId = queryStore.openTableStructure("conn-1", "db", undefined, "users");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { dirty: true } as typeof tab.structureDraft;
    return tabId;
  }

  it("skips the quit prompt and keeps unsaved drafts by default", async () => {
    const { queryStore } = await createStoreWithDirtyQueryTab();

    const confirmed = queryStore.requestAppCloseConfirmation();

    expect(confirmed).toBe(false);
    expect(queryStore.showCloseConfirm).toBe(false);
    expect(queryStore.tabs[0].sql).toBe("select 1;");
    expect(queryStore.isTabDirty(queryStore.tabs[0])).toBe(true);
    expect(queryStore.requiresAppCloseDraftPersist).toBe(true);
  });

  it("prompts for unsaved SQL when quitting in prompt mode", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "prompt" });

    const { queryStore } = await createStoreWithDirtyQueryTab();

    const confirmed = queryStore.requestAppCloseConfirmation();

    expect(confirmed).toBe(true);
    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.closeConfirmContext).toBe("app");
  });

  it("does not require draft persistence when unsaved SQL confirmation is disabled", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({
      confirmUnsavedSqlClose: false,
      appCloseUnsavedTabsMode: "keep-drafts",
    });
    const { queryStore } = await createStoreWithDirtyQueryTab();

    expect(queryStore.requestAppCloseConfirmation()).toBe(false);
    expect(queryStore.requiresAppCloseDraftPersist).toBe(false);
  });

  it("does not require draft persistence without dirty SQL", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    queryStore.createTab("conn-1", "db");

    expect(queryStore.requiresAppCloseDraftPersist).toBe(false);
  });

  it("still confirms individual dirty tab closes in keep-drafts mode", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" });

    const { queryStore, tabId } = await createStoreWithDirtyQueryTab();

    queryStore.closeTab(tabId);

    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.closeConfirmContext).toBe("tab");
    expect(queryStore.tabs[0].sql).toBe("select 1;");
  });

  it("still protects a dirty structure tab during app close in keep-drafts mode", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const structureTabId = await createDirtyStructureTab(queryStore);

    expect(queryStore.requestAppCloseConfirmation()).toBe(true);
    expect(queryStore.closeConfirmContext).toBe("app");
    expect(queryStore.closeConfirmDirtyTabIds).toEqual([structureTabId]);
  });

  it("keeps dirty SQL drafts while protecting structure edits during app close", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" });
    const { queryStore, tabId: queryTabId } = await createStoreWithDirtyQueryTab();
    const structureTabId = await createDirtyStructureTab(queryStore);

    expect(queryStore.requestAppCloseConfirmation()).toBe(true);
    expect(queryStore.closeConfirmDirtyTabIds).toEqual([structureTabId]);

    queryStore.forceCloseAllPendingTabs();

    const queryTab = queryStore.tabs.find((tab) => tab.id === queryTabId)!;
    expect(queryTab.sql).toBe("select 1;");
    expect(queryStore.isTabDirty(queryTab)).toBe(true);
    expect(queryStore.requestAppCloseConfirmation()).toBe(false);
  });

  it("blocks app close when saving keep-drafts state fails", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ appCloseUnsavedTabsMode: "keep-drafts" });
    const { queryStore } = await createStoreWithDirtyQueryTab();
    const beforeClose = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const onPersistError = vi.fn();
    mocks.saveOpenTabsState.mockRejectedValueOnce(new Error("disk full"));

    const closed = await finishAppCloseWithRequiredPersist({
      persist: () => queryStore.flushPendingPersist(),
      beforeClose,
      close,
      onPersistError,
    });

    expect(closed).toBe(false);
    expect(mocks.saveOpenTabsState).toHaveBeenCalledOnce();
    expect(beforeClose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(onPersistError).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }));
  });

  it("disposes runtime only after draft state is persisted", async () => {
    const calls: string[] = [];

    const closed = await finishAppCloseWithRequiredPersist({
      persist: async () => {
        calls.push("persist");
      },
      beforeClose: async () => {
        calls.push("dispose");
      },
      close: async () => {
        calls.push("close");
      },
      onPersistError: vi.fn(),
    });

    expect(closed).toBe(true);
    expect(calls).toEqual(["persist", "dispose", "close"]);
  });
});
