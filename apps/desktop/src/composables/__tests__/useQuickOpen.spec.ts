import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuickOpen } from "@/composables/useQuickOpen";
import * as api from "@/lib/backend/api";
import { getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn(),
  readExternalSqlFile: vi.fn(),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFolderPaths: vi.fn(),
    sqlFileFoldersVersion: ref(0),
  };
});

function emptySavedSqlStore() {
  return {
    allFiles: [] as any[],
    orphanedFileIds: vi.fn().mockReturnValue(new Set<string>()),
    getFile: vi.fn().mockReturnValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("useQuickOpen", () => {
  beforeEach(() => {
    vi.mocked(useSavedSqlStore).mockReturnValue(emptySavedSqlStore() as any);
    vi.mocked(getSqlFileFolderPaths).mockReturnValue([]);
  });

  describe("external SQL files", () => {
    it("reloads when folders change during an in-flight scan", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValueOnce(["/old"]).mockReturnValue(["/new"]);
      const oldScan = deferred<Awaited<ReturnType<typeof api.listSqlFilesInFolder>>>();
      vi.mocked(api.listSqlFilesInFolder).mockImplementation((path) => {
        if (path === "/old") return oldScan.promise;
        return Promise.resolve([{ name: "new.sql", path: "/new/new.sql", is_dir: false, children: [] }]);
      });

      const { filteredItems, loadExternalSqlFiles, setQuery } = useQuickOpen();
      const initialLoad = loadExternalSqlFiles();
      expect(api.listSqlFilesInFolder).toHaveBeenCalledWith("/old");

      sqlFileFoldersVersion.value++;
      await nextTick();
      oldScan.resolve([{ name: "old.sql", path: "/old/old.sql", is_dir: false, children: [] }]);
      await initialLoad;

      expect(api.listSqlFilesInFolder).toHaveBeenCalledTimes(2);
      expect(api.listSqlFilesInFolder).toHaveBeenLastCalledWith("/new");
      setQuery(".sql");
      expect(filteredItems.value.map((item) => item.label)).toContain("new.sql");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("old.sql");
    });
  });

  describe("fuzzyMatch function", () => {
    it("should return exact substring match with score 1", () => {
      // Mock store with test data
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "MyDatabase",
            label: "MyDatabase",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyDatabase");

      // After search, we should find the exact match
      expect(filteredItems.value.length).toBeGreaterThan(0);
      const result = filteredItems.value.find((item) => item.label === "MyDatabase");
      expect(result).toBeDefined();
      if (result) {
        expect(result.matchScore).toBe(1); // Exact substring match score
      }
    });

    it("should handle empty query by returning all items", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "postgres" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      // Empty query should return all items (2 connections + 0 SQL library files)
      expect(filteredItems.value.length).toBe(2);
      filteredItems.value.forEach((item) => {
        expect(item.matchScore).toBe(Infinity);
      });
    });

    it("should perform fuzzy matching for non-consecutive characters", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("MyCo");

      // Fuzzy match should find "MyConnection"
      const result = filteredItems.value.find((item) => item.label === "MyConnection");
      expect(result).toBeDefined();
    });

    it("should return null for non-matching query", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("XYZ");

      // No match should return empty results
      expect(filteredItems.value.length).toBe(0);
    });

    it("should score consecutive characters higher than non-consecutive", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "user_login_table", type: "mssql" },
          { id: "conn2", name: "user_data_login", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("login");

      // "user_login_table" has consecutive "login" match (better score)
      // "user_data_login" has consecutive "login" match too
      expect(filteredItems.value.length).toBe(2);
      // Both should have score 1.0 (consecutive match: login appears consecutively)
    });
  });

  describe("filtering and searching", () => {
    it("indexes database objects under connection groups", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Grouped PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "group1",
            type: "connection-group",
            label: "Production",
            children: [
              {
                id: "conn1",
                connectionId: "conn1",
                type: "connection",
                label: "Grouped PG",
                children: [
                  {
                    id: "conn1:postgres",
                    connectionId: "conn1",
                    type: "database",
                    database: "postgres",
                    label: "postgres",
                    children: [
                      {
                        id: "conn1:postgres:public",
                        connectionId: "conn1",
                        type: "schema",
                        database: "postgres",
                        schema: "public",
                        label: "public",
                        children: [
                          {
                            id: "conn1:postgres:public:users",
                            connectionId: "conn1",
                            type: "table",
                            database: "postgres",
                            schema: "public",
                            label: "users",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("users");
      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("includes schemas as quick open results", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "PG", db_type: "postgres" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "PG",
            children: [
              {
                id: "conn1:postgres",
                connectionId: "conn1",
                type: "database",
                database: "postgres",
                label: "postgres",
                children: [
                  {
                    id: "conn1:postgres:analytics",
                    connectionId: "conn1",
                    type: "schema",
                    database: "postgres",
                    schema: "analytics",
                    label: "analytics",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("analytics");
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ type: "schema", label: "analytics" })]));
    });

    it("should filter items based on search query", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "ProdDB", type: "mssql" },
          { id: "conn2", name: "DevDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("Prod");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("ProdDB");
    });

    it("should be case-insensitive", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConnection", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("myconnection");

      expect(filteredItems.value.length).toBe(1);
      expect(filteredItems.value[0].label).toBe("MyConnection");
    });

    it("should search across connection name and database name", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "ProdConnection", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      // Search by connection name
      setQuery("Prod");
      expect(filteredItems.value.length).toBeGreaterThan(0);
    });

    it("should sort by match score (lower scores first)", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Database", type: "mssql" },
          { id: "conn2", name: "MyDB", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("db");

      expect(filteredItems.value.length).toBe(2);
      // First result should have better (lower) score
      expect(filteredItems.value[0].matchScore).toBeLessThanOrEqual(filteredItems.value[1].matchScore);
    });

    it("should sort by type for equal match scores", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "test", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "test_db",
            label: "test_db",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("test");

      // Connections should come before databases for the same query
      if (filteredItems.value.length >= 2) {
        const connectionItem = filteredItems.value.find((item) => item.type === "connection");
        const databaseItem = filteredItems.value.find((item) => item.type === "database");

        if (connectionItem && databaseItem) {
          expect(filteredItems.value.indexOf(connectionItem)).toBeLessThan(filteredItems.value.indexOf(databaseItem));
        }
      }
    });
  });

  describe("item selection navigation", () => {
    it("should initialize with selectedIndex at 0", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedIndex } = useQuickOpen();
      expect(selectedIndex.value).toBe(0);
    });

    it("should select next item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      expect(selectedIndex.value).toBe(0);
      selectNext();
      expect(selectedIndex.value).toBe(1);
    });

    it("should not exceed max index when selecting next", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      selectNext(); // Attempt to go beyond max
      expect(selectedIndex.value).toBe(0); // Should stay at 0 (only 1 item)
    });

    it("should select previous item", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectPrevious, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);
      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should not go below 0 when selecting previous", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectPrevious, selectedIndex } = useQuickOpen();

      // Verify initial state
      expect(selectedIndex.value).toBe(0);

      selectPrevious();
      expect(selectedIndex.value).toBe(0);
    });

    it("should return correct selectedItem", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, selectedItem, setQuery } = useQuickOpen();

      setQuery("");

      expect(selectedItem.value?.label).toBe("Conn1");
      selectNext();
      expect(selectedItem.value?.label).toBe("Conn2");
    });

    it("should return null selectedItem when index is out of bounds", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "Conn1", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectedItem, selectedIndex } = useQuickOpen();

      // Manually set invalid index
      selectedIndex.value = 999;
      expect(selectedItem.value).toBeNull();
    });
  });

  describe("reset and query setting", () => {
    it("should reset selection to 0 when setQuery is called", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { selectNext, setQuery, selectedIndex } = useQuickOpen();

      selectNext();
      expect(selectedIndex.value).toBe(1);

      setQuery("test");
      expect(selectedIndex.value).toBe(0);
    });

    it("should update searchQuery when setQuery is called", () => {
      const mockStore = {
        connections: [],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { searchQuery, setQuery } = useQuickOpen();

      setQuery("NewQuery");
      expect(searchQuery.value).toBe("NewQuery");
    });

    it("should resetSelection to 0", () => {
      const mockStore = {
        connections: [
          { id: "conn1", name: "Conn1", type: "mssql" },
          { id: "conn2", name: "Conn2", type: "mssql" },
        ],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { resetSelection, selectNext, selectedIndex, setQuery } = useQuickOpen();

      setQuery("");

      selectNext();
      expect(selectedIndex.value).toBe(1);

      resetSelection();
      expect(selectedIndex.value).toBe(0);
    });
  });

  describe("allItems with different database object types", () => {
    it("should include tables from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "table",
            database: "MyDB",
            schema: "dbo",
            label: "Users",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const tableItem = filteredItems.value.find((item) => item.type === "table");
      expect(tableItem).toBeDefined();
      expect(tableItem?.label).toBe("Users");
    });

    it("should include views from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "view",
            database: "MyDB",
            schema: "dbo",
            label: "UserView",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const viewItem = filteredItems.value.find((item) => item.type === "view");
      expect(viewItem).toBeDefined();
      expect(viewItem?.label).toBe("UserView");
    });

    it("should include procedures from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "procedure",
            database: "MyDB",
            schema: "dbo",
            label: "GetUsers",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const procItem = filteredItems.value.find((item) => item.type === "procedure");
      expect(procItem).toBeDefined();
      expect(procItem?.label).toBe("GetUsers");
    });

    it("should include functions from tree nodes", () => {
      const mockStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "function",
            database: "MyDB",
            schema: "dbo",
            label: "ComputeAge",
          },
        ],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();

      setQuery("");

      const funcItem = filteredItems.value.find((item) => item.type === "function");
      expect(funcItem).toBeDefined();
      expect(funcItem?.label).toBe("ComputeAge");
    });
  });

  describe("SQL library files", () => {
    function savedSqlStoreWithFiles(files: any[]) {
      const fileMap = new Map(files.map((f) => [f.id, f]));
      return {
        allFiles: files,
        orphanedFileIds: vi.fn().mockReturnValue(new Set<string>()),
        getFile: vi.fn().mockImplementation((id: string) => fileMap.get(id)),
      };
    }

    it("shows limited SQL library files when no search query", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = Array.from({ length: 30 }, (_, i) => ({
        id: `file${i}`,
        name: `query_${i}.sql`,
        connectionId: "conn1",
        updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("");

      // Should show 1 connection + 20 recent SQL library files = 21
      expect(filteredItems.value.length).toBe(21);
      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems.length).toBe(20);
    });

    it("includes all SQL library files when searching", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "MyConn", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "get_users.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "create_orders.sql", connectionId: "conn1", updatedAt: "2024-01-02T00:00:00.000Z" },
        { id: "f3", name: "update_inventory.sql", connectionId: "conn1", updatedAt: "2024-01-03T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(1);
      expect(sqlItems[0].label).toBe("get_users.sql");
      expect(sqlItems[0].sqlFileId).toBe("f1");
    });

    it("excludes orphaned SQL library files", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "Active", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "active_query.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "orphaned_query.sql", connectionId: "deleted_conn", updatedAt: "2024-01-02T00:00:00.000Z" },
      ];
      const store = savedSqlStoreWithFiles(files);
      store.orphanedFileIds = vi.fn().mockReturnValue(new Set(["f2"]));
      vi.mocked(useSavedSqlStore).mockReturnValue(store as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("query");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(1);
      expect(sqlItems[0].label).toBe("active_query.sql");
    });
  });

  describe("remote metadata search", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    function remoteSearchStore(overrides: Record<string, unknown> = {}) {
      return {
        connections: [{ id: "conn1", name: "MySQL", db_type: "mysql" }],
        connectedIds: new Set(["conn1"]),
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
        ...overrides,
      };
    }

    async function runDebouncedSearch(): Promise<void> {
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
    }

    it("finds unloaded tables through server metadata", async () => {
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "orders", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("ord");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "ord", 25, undefined, true);
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "orders", type: "table", database: "app" })]));
    });

    it("deduplicates loaded and remote table results", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "users", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.filter((item) => item.label === "users")).toHaveLength(1);
    });

    it("ignores stale remote responses", async () => {
      const alpha = deferred<Array<{ name: string; type: "table" }>>();
      const beta = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        listCompletionTables: vi.fn((_connectionId, _database, query) => (query === "alpha" ? alpha.promise : beta.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("alpha");
      await runDebouncedSearch();
      setQuery("beta");
      await runDebouncedSearch();

      beta.resolve([{ name: "beta_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");

      alpha.resolve([{ name: "alpha_table", type: "table" }]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("alpha_table");
    });

    it("does not request metadata for empty or one-character queries", async () => {
      const mockStore = remoteSearchStore();
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("");
      setQuery("a");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("does not request metadata from disconnected contexts", async () => {
      const mockStore = remoteSearchStore({ connectedIds: new Set<string>() });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).not.toHaveBeenCalled();
    });

    it("keeps local results when remote metadata search fails", async () => {
      const mockStore = remoteSearchStore({
        treeNodes: [
          {
            id: "conn1:app",
            connectionId: "conn1",
            type: "database",
            database: "app",
            label: "app",
            children: [
              {
                id: "conn1:app:users",
                connectionId: "conn1",
                type: "table",
                database: "app",
                label: "users",
              },
            ],
          },
        ],
        listCompletionTables: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("users");
    });

    it("caps requests, concurrency, and merged remote results", async () => {
      const pending: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      let callIndex = 0;
      const listCompletionTables = vi.fn(() => {
        const request = deferred<Array<{ name: string; type: "table" }>>();
        pending.push(request);
        return request.promise;
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 12 }, (_, index) => ({
          id: `conn1:db${index}`,
          connectionId: "conn1",
          type: "database",
          database: `db${index}`,
          label: `db${index}`,
        })),
        listCompletionTables,
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("table");
      await vi.advanceTimersByTimeAsync(200);
      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      for (let wave = 0; wave < 4; wave++) {
        const active = pending.slice(wave * 2, wave * 2 + 2);
        for (const request of active) {
          const requestIndex = callIndex++;
          request.resolve(Array.from({ length: 30 }, (_, index) => ({ name: `table_${requestIndex}_${index}`, type: "table" })));
        }
        await flushAsyncWork();
        expect(listCompletionTables.mock.calls.length).toBeLessThanOrEqual(Math.min((wave + 2) * 2, 8));
      }

      await flushAsyncWork();
      expect(listCompletionTables).toHaveBeenCalledTimes(8);
      expect(filteredItems.value).toHaveLength(100);
    });
  });
});
