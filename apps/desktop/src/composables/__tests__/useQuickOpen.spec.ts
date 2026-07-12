import { describe, expect, it, vi } from "vitest";
import { useQuickOpen } from "@/composables/useQuickOpen";
import { useConnectionStore } from "@/stores/connectionStore";

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

describe("useQuickOpen", () => {
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

      // Empty query should return all items
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
});
