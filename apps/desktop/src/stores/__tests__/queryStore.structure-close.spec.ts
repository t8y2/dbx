import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore structure editor close protection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("prompts before closing a dirty structure tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openTableStructure("mysql-1", "app", undefined, "users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { dirty: true } as typeof tab.structureDraft;

    store.closeTab(tabId);

    expect(store.showCloseConfirm).toBe(true);
    expect(store.pendingCloseTabId).toBe(tabId);
    expect(store.tabs.some((item) => item.id === tabId)).toBe(true);
  });

  it("closes a clean structure tab without prompting", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openTableStructure("mysql-1", "app", undefined, "users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { dirty: false } as typeof tab.structureDraft;

    store.closeTab(tabId);

    expect(store.showCloseConfirm).toBe(false);
    expect(store.tabs.some((item) => item.id === tabId)).toBe(false);
  });

  it("protects legacy persisted structure drafts without a dirty flag", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openTableStructure("mysql-1", "app", undefined, "users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { initialized: true } as typeof tab.structureDraft;

    store.closeTab(tabId);

    expect(store.showCloseConfirm).toBe(true);
    expect(store.pendingCloseTabId).toBe(tabId);
  });

  it("protects dirty structure tabs during batch and app close", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.confirmUnsavedSqlClose = false;
    const store = useQueryStore();
    const tabId = store.openTableStructure("mysql-1", "app", undefined, "users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { dirty: true } as typeof tab.structureDraft;

    store.closeAllTabs();
    expect(store.showCloseConfirm).toBe(true);
    expect(store.closeConfirmContext).toBe("batch");

    store.cancelClosePendingTab();
    expect(store.requestAppCloseConfirmation()).toBe(true);
    expect(store.closeConfirmContext).toBe("app");
  });

  it("discards a structure draft before force closing", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openTableStructure("mysql-1", "app", undefined, "users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.structureDraft = { dirty: true } as typeof tab.structureDraft;

    store.closeTab(tabId);
    store.forceClosePendingTab();

    expect(store.tabs.some((item) => item.id === tabId)).toBe(false);
  });

  it("preserves the disabled SQL close-confirm behavior", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.confirmUnsavedSqlClose = false;
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query");
    store.updateSql(tabId, "select 1");

    store.closeTab(tabId);

    expect(store.showCloseConfirm).toBe(false);
    expect(store.tabs.some((item) => item.id === tabId)).toBe(false);
  });
});
