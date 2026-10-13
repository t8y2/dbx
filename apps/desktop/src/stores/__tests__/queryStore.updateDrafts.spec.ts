import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const savedFile = { id: "saved", connectionId: "conn", database: "db", name: "saved.sql", sql: "SELECT 1;", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" };
const mocks = vi.hoisted(() => ({ saved: null as any }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  loadOpenTabsState: async () => mocks.saved,
  saveOpenTabsState: async (payload: unknown) => {
    mocks.saved = payload;
  },
  listDetachedTabHandoffs: async () => [],
}));
describe("update draft recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.saved = null;
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    setActivePinia(createPinia());
  });
  it.each(["", "SELECT 2;"])("preserves a saved SQL draft %j through recovery and file hydration", async (sql) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useSavedSqlStore } = await import("@/stores/savedSqlStore");
    const { UPDATE_RESTORE_KEY } = await import("@/lib/app/updatePreparation");
    const store = useQueryStore();
    const id = store.createTab("conn", "db");
    Object.assign(store.tabs.find((tab) => tab.id === id)!, { savedSqlId: "saved", sql, originalSql: "SELECT 1;" });
    await store.flushPendingPersist();
    localStorage.setItem(UPDATE_RESTORE_KEY, "1");
    setActivePinia(createPinia());
    useSettingsStore().updateEditorSettings({ openTabsRestoreMode: "none", confirmUnsavedSqlClose: false });
    const ensureFileContent = vi.spyOn(useSavedSqlStore(), "ensureFileContent");
    const restored = useQueryStore();
    await restored.initOpenTabs({ validConnectionIds: ["conn"] });
    await restored.hydrateSavedSqlTabs();
    const tab = restored.tabs.find((tab) => tab.id === id)!;
    expect(tab.sql).toBe(sql);
    expect(tab.originalSql).toBe("SELECT 1;");
    expect(restored.isTabDirty(tab)).toBe(true);
    expect(ensureFileContent).not.toHaveBeenCalled();
    expect(localStorage.getItem(UPDATE_RESTORE_KEY)).toBeNull();
    expect(restored.openSavedSql(savedFile)).toBe(id);
    expect(tab.sql).toBe(sql);
    expect(tab.originalSql).toBe("SELECT 1;");
    expect(restored.isTabDirty(tab)).toBe(true);
    ensureFileContent.mockRestore();
  });

  it("loads file content when reopening a clean restored SQL library tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { UPDATE_RESTORE_KEY } = await import("@/lib/app/updatePreparation");
    const store = useQueryStore();
    const id = store.openSavedSql(savedFile);
    await store.flushPendingPersist();
    localStorage.setItem(UPDATE_RESTORE_KEY, "1");
    setActivePinia(createPinia());
    const restored = useQueryStore();
    await restored.initOpenTabs({ validConnectionIds: ["conn"] });
    const tab = restored.tabs.find((tab) => tab.id === id)!;
    expect(tab.sql).toBe("");
    expect(tab.originalSql).toBeUndefined();
    expect(restored.openSavedSql(savedFile)).toBe(id);
    expect(tab.sql).toBe(savedFile.sql);
    expect(tab.originalSql).toBe(savedFile.sql);
    expect(restored.isTabDirty(tab)).toBe(false);
  });

  it("recovers SQL and structure drafts once even when normal restore and close protection are disabled", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { UPDATE_RESTORE_KEY } = await import("@/lib/app/updatePreparation");
    const settings = useSettingsStore();
    settings.updateEditorSettings({ openTabsRestoreMode: "none", confirmUnsavedSqlClose: false });
    const store = useQueryStore();
    const sqlId = store.createTab("conn", "db");
    store.updateSql(sqlId, "select unsaved;");
    const structureId = store.openTableStructure("conn", "db", undefined, "users");
    const draft = { dirty: true, initialized: true, ddlDraft: "alter table users add column name text" };
    store.tabs.find((tab) => tab.id === structureId)!.structureDraft = draft as any;
    await store.flushPendingPersist();
    localStorage.setItem(UPDATE_RESTORE_KEY, "1");
    setActivePinia(createPinia());
    useSettingsStore().updateEditorSettings({ openTabsRestoreMode: "none", confirmUnsavedSqlClose: false });
    const restored = useQueryStore();
    await restored.initOpenTabs({ validConnectionIds: ["conn"] });
    expect(restored.tabs.find((tab) => tab.id === sqlId)?.sql).toBe("select unsaved;");
    expect(restored.tabs.find((tab) => tab.id === structureId)?.structureDraft).toEqual(draft);
    expect(localStorage.getItem(UPDATE_RESTORE_KEY)).toBeNull();
    setActivePinia(createPinia());
    useSettingsStore().updateEditorSettings({ openTabsRestoreMode: "none" });
    const subsequent = useQueryStore();
    await subsequent.initOpenTabs({ validConnectionIds: ["conn"] });
    expect(subsequent.tabs).toEqual([]);
  });
});
