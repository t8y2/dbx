import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore switchTab", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  it("deactivates settings page when switching to the same tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();

    // Create a data tab
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    queryStore.activeTabId = tabId;

    // Simulate settings page being active
    settingsStore.settingsPageActive = true;

    // Switch to the same tab (simulating reuseDataTab scenario)
    queryStore.switchTab(tabId);

    // Settings page should be deactivated
    expect(settingsStore.settingsPageActive).toBe(false);
    // Active tab should still be the same
    expect(queryStore.activeTabId).toBe(tabId);
  });

  it("deactivates settings page when switching to a different tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();

    // Create two data tabs
    const tab1Id = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab2Id = queryStore.createTab("pg-1", "app", "orders", "data", "public");
    queryStore.activeTabId = tab1Id;

    // Simulate settings page being active
    settingsStore.settingsPageActive = true;

    // Switch to a different tab
    queryStore.switchTab(tab2Id);

    // Settings page should be deactivated
    expect(settingsStore.settingsPageActive).toBe(false);
    // Active tab should be the new tab
    expect(queryStore.activeTabId).toBe(tab2Id);
  });

  it("deactivates settings page when reopening an existing special tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();

    const tabId = queryStore.openObjectBrowser("pg-1", "app", "public");
    settingsStore.settingsPageActive = true;

    const reopenedTabId = queryStore.openObjectBrowser("pg-1", "app", "public");

    expect(reopenedTabId).toBe(tabId);
    expect(queryStore.activeTabId).toBe(tabId);
    expect(settingsStore.settingsPageActive).toBe(false);
  });
});
