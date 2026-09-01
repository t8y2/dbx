import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryStore } from "@/stores/queryStore";

describe("queryStore switchTab", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
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

  it("notifies the app when switching to an existing tab", async () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const dispatchEvent = window.dispatchEvent as ReturnType<typeof vi.fn>;

    queryStore.switchTab(tabId);

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "dbx:activate-query-surface" }));
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

  it("inserts a tab after the active tab only when explicitly requested", async () => {
    const queryStore = useQueryStore();
    const firstId = queryStore.createTab("pg-1", "app", "Query 1", "query");
    const trailingId = queryStore.createTab("pg-1", "app", "Query 2", "query");
    queryStore.switchTab(firstId);

    const dataId = queryStore.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true, insertAfterActive: true });
    const appendedId = queryStore.createTab("pg-1", "app", "Query 3", "query", undefined, undefined, undefined, { forceNew: true });

    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([firstId, dataId, trailingId, appendedId]);
  });

  it("appends when adjacent insertion has no valid active tab", async () => {
    const queryStore = useQueryStore();
    const firstId = queryStore.createTab("pg-1", "app", "Query 1", "query");
    queryStore.activeTabId = "missing-tab";

    const dataId = queryStore.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true, insertAfterActive: true });

    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([firstId, dataId]);
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

  it("keeps same-named tabs from different catalogs distinct", async () => {
    const queryStore = useQueryStore();

    const paimonTabId = queryStore.createTab("sr-1", "bi", "events", "query", undefined, undefined, "paimon_catalog");
    const internalTabId = queryStore.createTab("sr-1", "bi", "events", "query", undefined, undefined, "internal");

    expect(internalTabId).not.toBe(paimonTabId);
    expect(queryStore.tabs).toHaveLength(2);
  });

  it("preserves catalog context when duplicating a query tab", async () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("sr-1", "bi", undefined, "query", undefined, "SELECT 1", "paimon_catalog");

    queryStore.duplicateTab(tabId);

    expect(queryStore.tabs).toHaveLength(2);
    expect(queryStore.tabs[1].catalog).toBe("paimon_catalog");
  });

  it("clones result column comments when duplicating a query tab", () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", undefined, "query", undefined, "SELECT 1");
    const original = queryStore.tabs.find((tab) => tab.id === tabId)!;
    original.resultColumnComments = ["identifier", "display name"];

    queryStore.duplicateTab(tabId);

    const duplicate = queryStore.tabs[1];
    expect(Array.isArray(duplicate.resultColumnComments)).toBe(true);
    expect(duplicate.resultColumnComments).toEqual(original.resultColumnComments);
    expect(duplicate.resultColumnComments).not.toBe(original.resultColumnComments);
  });

  it("switches catalog and database as one query context", () => {
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("sr-1", "internal_db", undefined, "query");
    const tab = queryStore.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateCatalog(tabId, "paimon_catalog", "bi");

    expect(tab.catalog).toBe("paimon_catalog");
    expect(tab.database).toBe("bi");
    expect(tab.result).toBeUndefined();
  });

  it("stores local data-grid column filters on the tab result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      columns: ["id", "status"],
      rows: [[1, "active"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateDataGridLocalColumnFilters(tabId, { "1": ["str:active"] });
    expect(tab.result.local_column_filters).toEqual({ "1": ["str:active"] });

    queryStore.updateDataGridLocalColumnFilters(tabId, {});
    expect(tab.result.local_column_filters).toBeUndefined();
  });

  it("keeps local filters isolated across result-run switches and clearing", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "Query", "query");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    const result = (filters?: Record<string, string[]>) => ({
      columns: ["id", "status"],
      rows: [[1, "active"]],
      affected_rows: 0,
      execution_time_ms: 1,
      local_column_filters: filters,
    });
    tab.resultRuns = [
      { id: "run-a", title: "Run A", sequence: 1, sql: "select 1", createdAt: 1, result: result() },
      { id: "run-b", title: "Run B", sequence: 2, sql: "select 2", createdAt: 2, result: result({ "1": ["str:pending"] }) },
    ];

    expect(await queryStore.setActiveResultRun(tabId, "run-a")).toBe(true);
    queryStore.updateDataGridLocalColumnFilters(tabId, { "1": ["str:active"] });
    expect(tab.resultRuns?.[0]?.result?.local_column_filters).toEqual({ "1": ["str:active"] });

    expect(await queryStore.setActiveResultRun(tabId, "run-b")).toBe(true);
    expect(tab.result?.local_column_filters).toEqual({ "1": ["str:pending"] });
    expect(await queryStore.setActiveResultRun(tabId, "run-a")).toBe(true);
    expect(tab.result?.local_column_filters).toEqual({ "1": ["str:active"] });

    queryStore.updateDataGridLocalColumnFilters(tabId, {});
    expect(await queryStore.setActiveResultRun(tabId, "run-b")).toBe(true);
    expect(await queryStore.setActiveResultRun(tabId, "run-a")).toBe(true);
    expect(tab.result?.local_column_filters).toBeUndefined();
  });

  it("stores hidden data-grid column keys on the tab result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabId = queryStore.createTab("pg-1", "app", "users", "data", "public");
    const tab = queryStore.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      columns: ["id", "status"],
      rows: [[1, "active"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    queryStore.updateDataGridHiddenColumnKeys(tabId, ["status\0\0"]);
    expect(tab.result.local_hidden_column_keys).toEqual(["status\0\0"]);

    queryStore.updateDataGridHiddenColumnKeys(tabId, []);
    expect(tab.result.local_hidden_column_keys).toBeUndefined();
  });

  it("opens one reusable Nacos dashboard tab per connection", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();

    const tabId = queryStore.openNacosDashboard("nacos-1");
    const reopenedTabId = queryStore.openNacosDashboard("nacos-1");

    expect(reopenedTabId).toBe(tabId);
    expect(queryStore.tabs.filter((tab) => tab.mode === "nacos-dashboard")).toHaveLength(1);
    expect(queryStore.activeTabId).toBe(tabId);
  });
});
