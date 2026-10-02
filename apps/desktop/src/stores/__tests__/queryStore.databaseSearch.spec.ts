import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSearchTabState } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
  return data;
}

const QUERY_STORE_TEST_TIMEOUT = 30_000;

describe("queryStore database-search tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  }, QUERY_STORE_TEST_TIMEOUT);

  it(
    "opens a new database-search tab with initial state",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const initialState: DatabaseSearchTabState = {
        keyword: "test_keyword",
        perTableLimit: 50,
        progressDone: 5,
        progressTotal: 10,
        results: [
          {
            id: "users:0",
            tableName: "users",
            matchedColumns: ["email"],
            preview: "email: test@example.com",
            whereInput: "\"email\" = 'test@example.com'",
          },
        ],
      };

      const tabId = store.openDatabaseSearch("conn-1", "mydb", "public", initialState);

      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === tabId);
      expect(tab).toBeDefined();
      expect(tab?.mode).toBe("database-search");
      expect(tab?.connectionId).toBe("conn-1");
      expect(tab?.database).toBe("mydb");
      expect(tab?.schema).toBe("public");
      expect(tab?.databaseSearchState).toMatchObject(initialState);
      expect(store.activeTabId).toBe(tabId);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "reuses an existing database-search tab and merges incoming state",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const firstId = store.openDatabaseSearch("conn-1", "mydb", "public", {
        keyword: "first",
      });

      const secondId = store.openDatabaseSearch("conn-1", "mydb", "public", {
        keyword: "updated",
        perTableLimit: 30,
      });

      expect(secondId).toBe(firstId);
      expect(store.tabs).toHaveLength(1);
      const tab = store.tabs.find((t) => t.id === firstId);
      expect(tab?.databaseSearchState?.keyword).toBe("updated");
      expect(tab?.databaseSearchState?.perTableLimit).toBe(30);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "opens distinct tabs for different databases or schemas",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const id1 = store.openDatabaseSearch("conn-1", "mydb", "public");
      const id2 = store.openDatabaseSearch("conn-1", "mydb", "private");
      const id3 = store.openDatabaseSearch("conn-1", "otherdb");

      expect(store.tabs).toHaveLength(3);
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );

  it(
    "updates tab databaseSearchState via updateDatabaseSearchState",
    async () => {
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();

      const tabId = store.openDatabaseSearch("conn-1", "mydb");
      const tab = store.tabs.find((t) => t.id === tabId)!;

      expect(tab.databaseSearchState).toBeUndefined();

      const nextState: DatabaseSearchTabState = {
        keyword: "users",
        perTableLimit: 25,
        results: [],
        tableErrors: [],
        generalError: "",
        progressDone: 10,
        progressTotal: 20,
      };

      store.updateDatabaseSearchState(tabId, nextState);
      expect(tab.databaseSearchState).toMatchObject(nextState);
    },
    QUERY_STORE_TEST_TIMEOUT,
  );
});
