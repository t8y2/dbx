import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

describe("queryStore split right", () => {
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

  it("moves a query tab into a new right group and focuses it", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const firstId = queryStore.createTab("pg-1", "app", "Query 1", "query");
    const secondId = queryStore.createTab("pg-1", "app", "Query 2", "query");

    const ok = queryStore.splitTabRight(firstId);

    expect(ok).toBe(true);
    expect(queryStore.groups).toHaveLength(2);
    expect(queryStore.groups[0].tabIds).toEqual([secondId]);
    expect(queryStore.groups[1].tabIds).toEqual([firstId]);
    expect(queryStore.focusedGroupId).toBe(queryStore.groups[1].id);
    expect(queryStore.activeTabId).toBe(firstId);
  });

  it("allows up to four groups and rejects the fifth split", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const ids = [
      queryStore.createTab("pg-1", "app", "Query 1", "query"),
      queryStore.createTab("pg-1", "app", "Query 2", "query"),
      queryStore.createTab("pg-1", "app", "Query 3", "query"),
      queryStore.createTab("pg-1", "app", "Query 4", "query"),
      queryStore.createTab("pg-1", "app", "Query 5", "query"),
    ];

    expect(queryStore.splitTabRight(ids[1])).toBe(true);
    expect(queryStore.groups).toHaveLength(2);
    expect(queryStore.splitTabRight(ids[2])).toBe(true);
    expect(queryStore.groups).toHaveLength(3);
    expect(queryStore.splitTabRight(ids[3])).toBe(true);
    expect(queryStore.groups).toHaveLength(4);
    expect(queryStore.splitTabRight(ids[4])).toBe(false);
    expect(queryStore.groups).toHaveLength(4);
  });

  it("splits non-query tabs into their own group like query tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    // A companion query tab keeps the store past the single-tab guard.
    queryStore.createTab("pg-1", "app", "Query 1", "query");
    const dataId = queryStore.createTab("pg-1", "app", "users", "data", "public");

    expect(queryStore.splitTabRight(dataId)).toBe(true);
    expect(queryStore.groups).toHaveLength(2);
    expect(queryStore.groups[1].tabIds).toEqual([dataId]);
    expect(queryStore.groups[1].activeTabId).toBe(dataId);
    expect(queryStore.activeTabId).toBe(dataId);
  });

  it("rejects splitting the only open tab, which would be a no-op", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const onlyId = queryStore.createTab("pg-1", "app", "Query 1", "query");
    const groupIdBefore = queryStore.groups[0].id;

    const ok = queryStore.splitTabRight(onlyId);

    // Splitting would move the tab into a new group and prune the emptied
    // source group, returning to the same single-group layout — rejected so
    // the menu item can render disabled instead of doing nothing.
    expect(ok).toBe(false);
    expect(queryStore.groups).toHaveLength(1);
    expect(queryStore.groups[0].id).toBe(groupIdBefore);
    expect(queryStore.groups[0].tabIds).toEqual([onlyId]);
    expect(queryStore.focusedGroupId).toBe(groupIdBefore);
  });
});
