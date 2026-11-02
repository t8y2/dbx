import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore source-view intent", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
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
