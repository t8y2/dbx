import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore source-view intent", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
  });

  it("opens source tabs next to the active tab without changing ordinary query placement", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "First");
    const last = store.createTab("pg-1", "app", "Last");
    store.switchTab(first);

    const source = store.createTab("pg-1", "app", "Source", "query", "public", "CREATE VIEW v AS SELECT 1", undefined, { sourceView: true });
    const ordinary = store.createTab("pg-1", "app", "Ordinary query");

    expect(store.tabs.map((tab) => tab.id)).toEqual([first, source, last, ordinary]);
    expect(store.groups[0].tabIds).toEqual([first, source, last, ordinary]);
  });

  it("honors an explicit request to append a source tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "First");
    const last = store.createTab("pg-1", "app", "Last");
    store.switchTab(first);
    const source = store.createTab("pg-1", "app", "Source", "query", undefined, undefined, undefined, { sourceView: true, insertAfterActive: false });

    expect(store.tabs.map((tab) => tab.id)).toEqual([first, last, source]);
    expect(store.groups[0].tabIds).toEqual([first, last, source]);
  });

  it("opens a source tab in the focused split without disturbing the other group", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "First");
    const left = store.createTab("pg-1", "app", "Left");
    store.splitTabRight(first);
    const last = store.createTab("pg-1", "app", "Last");
    store.switchTab(first);

    const source = store.createTab("pg-1", "app", "Source", "query", undefined, undefined, undefined, { sourceView: true });

    expect(store.groups[0].tabIds).toEqual([left]);
    expect(store.groups[1].tabIds).toEqual([first, source, last]);
    expect(store.groups[1].activeTabId).toBe(source);
    expect(store.focusedGroupId).toBe(store.groups[1].id);
    expect(store.activeTabId).toBe(source);
  });

  it("keeps new source tabs behind the fixed tabs when the active tab is fixed", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "First");
    const second = store.createTab("pg-1", "app", "Second");
    const last = store.createTab("pg-1", "app", "Last");
    store.togglePinnedTab(first);
    store.togglePinnedTab(second);
    store.switchTab(first);

    const source = store.createTab("pg-1", "app", "Source", "query", undefined, undefined, undefined, { sourceView: true });

    expect(store.groups[0].tabIds).toEqual([first, second, source, last]);
    expect(store.tabs.find((tab) => tab.id === source)?.pinned).toBeFalsy();
  });

  it("opens editable source beside the active tab and reuses it without reordering or losing edits", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "First");
    const last = store.createTab("pg-1", "app", "Last");
    store.switchTab(first);
    const options = { connectionId: "pg-1", database: "app", title: "Source - users", sql: "CREATE VIEW users AS SELECT 1", objectSource: { name: "users", objectType: "VIEW" as const } };
    const source = store.openObjectSourceTab(options);
    expect(store.groups[0].tabIds).toEqual([first, source, last]);

    store.updateSql(source, "CREATE VIEW users AS SELECT 2");
    store.switchTab(last);
    expect(store.openObjectSourceTab(options)).toBe(source);
    expect(store.groups[0].tabIds).toEqual([first, source, last]);
    expect(store.tabs.find((tab) => tab.id === source)?.sql).toBe("CREATE VIEW users AS SELECT 2");
    expect(store.activeTabId).toBe(source);
  });

  it("preserves read-only source intent when duplicating a tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "Source - seq_users", "query", "public", "CREATE SEQUENCE seq_users", undefined, { sourceView: true });
    store.duplicateTab(id);
    expect(store.tabs).toHaveLength(2);
    for (const tab of store.tabs) {
      expect(tab.sourceView).toBe(true);
      expect(tab.objectSource).toBeUndefined();
    }
  });

  it("marks a reused legacy source tab without relying on its title to detect intent", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "Source - seq_users");
    expect(store.tabs[0]?.sourceView).toBeUndefined();
    const reused = store.createTab("pg-1", "app", "Source - seq_users", "query", undefined, undefined, undefined, { sourceView: true });
    expect(reused).toBe(id);
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sourceView).toBe(true);
    expect(store.tabs[0]?.objectSource).toBeUndefined();
  });

  it("marks new and reused editable object-source tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const options = { connectionId: "pg-1", database: "app", title: "Source - users", sql: "CREATE VIEW users AS SELECT 1", objectSource: { name: "users", objectType: "VIEW" as const } };
    const id = store.openObjectSourceTab(options);
    expect(store.tabs[0]?.sourceView).toBe(true);
    store.tabs[0]!.sourceView = undefined;
    expect(store.openObjectSourceTab(options)).toBe(id);
    expect(store.tabs[0]?.sourceView).toBe(true);
    expect(store.tabs[0]?.objectSource).toEqual(options.objectSource);
  });
});
