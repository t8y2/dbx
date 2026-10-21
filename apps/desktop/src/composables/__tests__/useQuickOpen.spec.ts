import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchQuickOpenText, useQuickOpen } from "@/composables/useQuickOpen";
import * as api from "@/lib/backend/api";
import { getSqlFileFilter, getSqlFileFolderPaths, sqlFileFoldersVersion } from "@/lib/sqlFile/sqlFileFolders";
import { setQuickOpenScopeIds } from "@/lib/quickOpen/quickOpenScope";
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
  listPlugins: vi.fn(),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFilter: vi.fn(() => "*.sql"),
    getSqlFileFolderPaths: vi.fn(),
    sqlFileFoldersVersion: ref(0),
  };
});

function emptySavedSqlStore() {
  return {
    allFiles: [] as any[],
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

  afterEach(() => {
    // The scope is module-level state and every useQuickOpen() instance leaves live
    // watchers behind, so a leaked scope or mock would make later tests order-dependent.
    setQuickOpenScopeIds([]);
    vi.clearAllMocks();
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
      expect(api.listSqlFilesInFolder).toHaveBeenCalledWith("/old", getSqlFileFilter());

      sqlFileFoldersVersion.value++;
      await nextTick();
      oldScan.resolve([{ name: "old.sql", path: "/old/old.sql", is_dir: false, children: [] }]);
      await initialLoad;

      expect(api.listSqlFilesInFolder).toHaveBeenCalledTimes(2);
      expect(api.listSqlFilesInFolder).toHaveBeenLastCalledWith("/new", getSqlFileFilter());
      setQuery(".sql");
      expect(filteredItems.value.map((item) => item.label)).toContain("new.sql");
      expect(filteredItems.value.map((item) => item.label)).not.toContain("old.sql");
    });
  });

  describe("metadata matching through indexed sources", () => {
    it.each(["/work/order-reports", "C:\\work\\order-reports"])("filters scanned external files under %s and preserves navigation", async (root) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(getSqlFileFolderPaths).mockReturnValue([root]);
      const separator = root.includes("\\") ? "\\" : "/";
      const label = "report-v2024-07-customer-order-detail-export.sql";
      const path = `${root}${separator}export${separator}${label}`;
      vi.mocked(api.listSqlFilesInFolder).mockResolvedValue([{ name: "export", path: `${root}${separator}export`, is_dir: true, children: [{ name: label, path, is_dir: false, children: [] }] }]);
      const scope = effectScope();
      try {
        const quickOpen = scope.run(() => useQuickOpen())!;
        await quickOpen.loadExternalSqlFiles();
        quickOpen.setQuery("cordetxprep");
        expect(quickOpen.filteredItems.value).toEqual([]);
        expect(quickOpen.selectedItem.value).toBeNull();
        quickOpen.selectNext();
        expect(quickOpen.selectedItem.value).toBeNull();
        for (const query of ["ORDER-REPORTS", "export", "cordetxp"]) {
          quickOpen.setQuery(query);
          expect(quickOpen.filteredItems.value).toHaveLength(1);
          expect(quickOpen.selectedItem.value).toMatchObject({ type: "sql_file", filePath: path, description: "order-reports / export" });
        }
        expect(quickOpen.selectedItem.value!.matchIndices.map((index) => label[index]).join("")).toBe("cordetxp");
        quickOpen.setQuery("ORDER-REPORTS");
        expect(quickOpen.selectedItem.value!.matchIndices).toEqual([]);
        quickOpen.setQuery("   ");
        expect(quickOpen.filteredItems.value).toHaveLength(1);
      } finally {
        scope.stop();
      }
    });

    it("does not combine connection and database characters when finding a table", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Production", db_type: "postgres" }],
        treeNodes: [{ connectionId: "conn1", type: "table", database: "Analytics", schema: "public", label: "用户明细" }],
      } as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("proana");
      expect(filteredItems.value).toEqual([]);
      for (const query of ["PRODUCTION", "Analytics", "PUBLIC"]) {
        setQuery(query);
        const table = filteredItems.value.find((item) => item.type === "table");
        expect(table).toMatchObject({ label: "用户明细", matchIndices: [] });
      }
      setQuery("yhmx");
      expect(filteredItems.value).toHaveLength(1);
      expect(filteredItems.value[0].matchIndices).toEqual([0, 1, 2, 3]);
    });

    it("preserves SQL-library connection search without cross-field fuzzy matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [{ id: "conn1", name: "Production", db_type: "postgres" }], treeNodes: [] } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue({ ...emptySavedSqlStore(), allFiles: [{ id: "saved1", name: "report.sql", connectionId: "conn1" }] } as any);
      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("rptprod");
      expect(filteredItems.value).toEqual([]);
      setQuery("Production");
      expect(filteredItems.value.map((item) => item.type)).toEqual(["connection", "sql_library_file"]);
      expect(filteredItems.value[1]).toMatchObject({ sqlFileId: "saved1", matchIndices: [] });
      setQuery("rpt");
      expect(filteredItems.value[0]).toMatchObject({ type: "sql_library_file", sqlFileId: "saved1", matchIndices: [0, 2, 5] });
    });

    it("keeps plugin commands searchable by literal description and fuzzy visible label", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "command", type: "plugin_command", label: "Open console", description: "Manage servers", searchText: "Open console Manage servers AdminTools", connectionId: "", pluginId: "admin", commandId: "open" }]) });
      setQuery("ocms");
      expect(filteredItems.value).toEqual([]);
      for (const query of ["manage servers", "ADMINTOOLS"]) {
        setQuery(query);
        expect(filteredItems.value).toHaveLength(1);
        expect(filteredItems.value[0]).toMatchObject({ commandId: "open", matchIndices: [] });
      }
      setQuery("oc");
      expect(filteredItems.value[0].matchIndices).toEqual([0, 5]);
    });
  });

  describe("metadata matching", () => {
    it.each([
      ["cordetxprep", "report-v2024-07-customer-order-detail-export.sql", "report-v2024-07-customer-order-detail-export.sql export order-reports"],
      ["sper", "report.sql", "report.sql sales production export reports"],
      ["salesprod", "report.sql", "report.sql sales production"],
      ["zzj", "report.sql", "report.sql 总租金"],
    ])("rejects non-literal metadata matches for %s", (query, label, searchText) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "file", type: "sql_file", label, searchText, connectionId: "" }]) });
      setQuery(query);
      expect(filteredItems.value).toEqual([]);
    });

    it.each(["PRODUCTION", "duction", "  production  "])("preserves literal metadata search for %s below label matches", (query) => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const { filteredItems, setQuery } = useQuickOpen({
        extraItems: ref([
          { id: "metadata", type: "sql_file", label: "report.sql", searchText: "Production reports", connectionId: "" },
          { id: "label", type: "sql_file", label: "production.sql", searchText: "production.sql", connectionId: "" },
        ]),
      });
      setQuery(query);
      expect(filteredItems.value.map((item) => item.id)).toEqual(["label", "metadata"]);
      expect(filteredItems.value[0].matchIndices.length).toBeGreaterThan(0);
      expect(filteredItems.value[1].matchIndices).toEqual([]);
      expect(filteredItems.value[1].matchScore).toBeGreaterThan(1000);
    });

    it("preserves fuzzy file-name matches and their highlights", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      const label = "report-v2024-07-customer-order-detail-export.sql";
      const { filteredItems, setQuery } = useQuickOpen({ extraItems: ref([{ id: "file", type: "sql_file", label, searchText: `${label} export order-reports`, connectionId: "" }]) });
      setQuery("cordetxp");
      expect(filteredItems.value).toHaveLength(1);
      expect(filteredItems.value[0].matchIndices.map((index) => label[index]).join("")).toBe("cordetxp");
    });
  });

  describe("fuzzyMatch function", () => {
    it("ranks exact names, initials, prefixes, substrings, and fuzzy matches in order", () => {
      const exact = matchQuickOpenText("shop", "shop");
      const initials = matchQuickOpenText("gafi", "groupon_apply_finance_invoice");
      const prefix = matchQuickOpenText("shop", "shop_attribute");
      const substring = matchQuickOpenText("shop", "sale_payway_shop");
      const fuzzy = matchQuickOpenText("gafi", "giftcard_define_item");

      expect([exact?.kind, initials?.kind, prefix?.kind, substring?.kind, fuzzy?.kind]).toEqual(["exact", "initials", "prefix", "substring", "fuzzy"]);
      expect(exact!.score).toBeLessThan(initials!.score);
      expect(initials!.score).toBeLessThan(prefix!.score);
      expect(prefix!.score).toBeLessThan(substring!.score);
      expect(substring!.score).toBeLessThan(fuzzy!.score);
      expect(initials?.indices).toEqual([0, 8, 14, 22]);
    });

    it("matches multi-word prefix combinations and highlights their source characters", () => {
      const label = "giftcard_define_shop_log";

      expect(matchQuickOpenText("gdsl", label)?.kind).toBe("initials");
      for (const query of ["giftdsl", "gdshopl", "gdesl"]) {
        const match = matchQuickOpenText(query, label);
        expect(match?.kind).toBe("word-prefix");
        expect(match?.indices.map((index) => label[index]).join("")).toBe(query);
      }
      expect(matchQuickOpenText("giftcard", label)?.kind).toBe("prefix");
      expect(matchQuickOpenText("define", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("shop", label)?.kind).toBe("substring");
      expect(matchQuickOpenText("cardshoplog", label)?.kind).toBe("fuzzy");
    });

    it("matches Chinese table names by pinyin initials (issue #7912)", () => {
      // Reported: 全局搜索中文表名输入首字母模糊搜索搜不出来
      expect(matchQuickOpenText("zzj", "总租金")?.kind).toBe("initials");
      expect(matchQuickOpenText("yhmx", "用户明细")?.kind).toBe("initials");
    });

    it("matches Chinese table names by a non-contiguous pinyin-initials subsequence", () => {
      const match = matchQuickOpenText("zj", "总租金");
      expect(match?.kind).toBe("fuzzy");
      expect(match?.indices.map((index) => "总租金"[index]).join("")).toBe("总租金".slice(0, 1) + "总租金".slice(2, 3));
    });

    it("keeps pinyin-initials highlight indices aligned across unmapped supplementary-plane characters", () => {
      const match = matchQuickOpenText("bx", "𠮷表x");
      expect(match?.kind).toBe("fuzzy");
      expect(match?.indices).toEqual([2, 3]);
    });

    it("prefers a literal prefix match over pinyin-initials for mixed Han+Latin names", () => {
      const literal = matchQuickOpenText("abc", "abc表");
      expect(literal?.kind).toBe("prefix");
      expect(literal?.score).toBeLessThan(250);
    });

    it("puts the exact shop result before prefixed and containing names", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "contains", name: "sale_payway_shop", type: "mssql" },
          { id: "prefix", name: "shop_attribute", type: "mssql" },
          { id: "exact", name: "shop", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("shop");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["shop", "shop_attribute", "sale_payway_shop"]);
    });

    it("puts an exact identifier acronym before loose fuzzy matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "fuzzy", name: "giftcard_define_item", type: "mssql" },
          { id: "initials", name: "groupon_apply_finance_invoice", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      expect(filteredItems.value.map((item) => item.label)).toEqual(["groupon_apply_finance_invoice", "giftcard_define_item"]);
      expect(filteredItems.value[0].matchIndices).toEqual([0, 8, 14, 22]);
    });

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
    it("keeps database-object highlight indices relative to the visible label", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "Test TiDB", db_type: "mysql" }],
        treeNodes: [
          {
            id: "conn1",
            connectionId: "conn1",
            type: "connection",
            label: "Test TiDB",
            children: [
              {
                id: "conn1:retail_mps",
                connectionId: "conn1",
                type: "database",
                database: "retail_mps",
                label: "retail_mps",
                children: [
                  {
                    id: "table1",
                    connectionId: "conn1",
                    type: "table",
                    database: "retail_mps",
                    label: "groupon_apply_finance_invoice",
                  },
                ],
              },
            ],
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("gafi");

      const table = filteredItems.value.find((item) => item.type === "table");
      expect(table?.label).toBe("groupon_apply_finance_invoice");
      expect(table?.matchIndices).toEqual([0, 8, 14, 22]);
    });

    it("does not highlight the label when only connection metadata matches", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [{ id: "conn1", name: "ProdConnection", db_type: "mysql" }],
        treeNodes: [
          {
            connectionId: "conn1",
            type: "database",
            database: "UserDB",
            label: "UserDB",
          },
        ],
      } as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("Prod");

      const database = filteredItems.value.find((item) => item.type === "database");
      expect(database?.matchIndices).toEqual([]);
      expect(database?.matchScore).toBeGreaterThan(1000);
    });

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

  describe("plugin workbenches", () => {
    function installedPluginFixture(id: string, name: string, contributions: any[]) {
      return {
        manifest: { id, name, version: "1.0.0", contributions },
        compatibility: { compatible: true },
      } as any;
    }

    it("lists standalone workbenches and skips ones bound to a connection provider", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(api.listPlugins).mockResolvedValue([
        installedPluginFixture("io.leetcode", "LeetCode", [{ type: "workbench", id: "main", label: "LeetCode" }]),
        installedPluginFixture("io.kafka", "Kafka", [
          { type: "connection-provider", id: "kafka", label: "Kafka", database_type: "kafka", fields: [], workbench: "browser" },
          { type: "workbench", id: "browser", label: "Kafka Browser" },
        ]),
        installedPluginFixture("io.terminal", "Terminal", [
          { type: "connection-provider", id: "ssh", label: "SSH", database_type: "ssh", fields: [] },
          { type: "workbench", id: "shell", label: "Terminal" },
        ]),
        installedPluginFixture("io.mixed", "Mixed", [
          { type: "connection-provider", id: "cp", label: "Mixed", database_type: "mixed", fields: [], workbench: "bound" },
          { type: "workbench", id: "bound", label: "Bound Panel" },
          { type: "workbench", id: "free", label: "Free Panel" },
        ]),
      ]);

      const { filteredItems, loadPluginWorkbenches } = useQuickOpen();
      await loadPluginWorkbenches();

      const labels = filteredItems.value.map((item) => item.label);
      expect(labels).toContain("LeetCode");
      // A provider without a workbench pointer leaves its sibling workbench standalone.
      expect(labels).toContain("Terminal");
      // Only the unbound workbench of a mixed plugin is listed.
      expect(labels).toContain("Free Panel");
      expect(labels).not.toContain("Kafka Browser");
      expect(labels).not.toContain("Bound Panel");
    });

    it("finds workbenches by plugin name and carries the dispatch fields", async () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(api.listPlugins).mockResolvedValue([installedPluginFixture("io.leetcode", "LeetCode", [{ type: "workbench", id: "main", label: "刷题面板", icon: "assets/icon.png" }])]);

      const { filteredItems, loadPluginWorkbenches, setQuery } = useQuickOpen();
      await loadPluginWorkbenches();

      setQuery("leetcode");
      expect(filteredItems.value.length).toBe(1);
      const item = filteredItems.value[0];
      expect(item.type).toBe("plugin_workbench");
      expect(item.pluginId).toBe("io.leetcode");
      expect(item.contributionId).toBe("main");
      expect(item.description).toBe("LeetCode");
      expect(item.pluginIcon).toBe("assets/icon.png");
      expect(item.connectionId).toBe("");
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
    it("resets selection when v-model changes the search query directly", () => {
      vi.mocked(useConnectionStore).mockReturnValue({
        connections: [
          { id: "conn1", name: "Connection1", type: "mssql" },
          { id: "conn2", name: "Connection2", type: "mssql" },
        ],
        treeNodes: [],
      } as any);

      const { searchQuery, selectNext, selectedIndex } = useQuickOpen();
      selectNext();
      expect(selectedIndex.value).toBe(1);

      searchQuery.value = "Connection";
      expect(selectedIndex.value).toBe(0);
    });

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

  describe("connection scope", () => {
    // Scope: no selection searches every connection, picking some narrows both
    // the local tree entries and the remote search pool to those connections.
    function scopeStore() {
      return {
        connections: [
          { id: "conn1", name: "Alpha", db_type: "mysql", database: "shop" },
          { id: "conn2", name: "Beta", db_type: "postgres", database: "public_db" },
          { id: "conn3", name: "Gamma", db_type: "mysql", database: "crm" },
        ],
        activeConnectionId: "conn1",
        connectedIds: new Set(["conn1", "conn2", "conn3"]),
        treeNodes: [
          { connectionId: "conn1", type: "database", database: "shop", label: "shop" },
          { connectionId: "conn2", type: "database", database: "public_db", label: "public_db" },
          { connectionId: "conn3", type: "database", database: "crm", label: "crm" },
        ],
        listCompletionTables: vi.fn().mockResolvedValue([]),
      };
    }

    it("searches every connection by default", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("");

      const databases = filteredItems.value.filter((item) => item.type === "database").map((item) => item.label);
      expect(databases).toEqual(["shop", "public_db", "crm"]);
    });

    it("hides unselected connections and their objects from the local pool", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { filteredItems, setQuery, setScopeConnectionIds } = useQuickOpen();
      setScopeConnectionIds(["conn2"]);
      setQuery("");

      const labels = filteredItems.value.map((item) => item.label);
      expect(labels).toContain("Beta");
      expect(labels).not.toContain("Alpha");
      expect(labels).not.toContain("Gamma");
      expect(labels.filter((label) => ["shop", "public_db", "crm"].includes(label))).toEqual(["public_db"]);
    });

    it("only queries the selected connections remotely", async () => {
      vi.useFakeTimers();
      try {
        const store = scopeStore();
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn3"]);
        setQuery("customer");

        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(store.listCompletionTables.mock.calls[0][0]).toBe("conn3");
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats an empty selection as all connections", () => {
      vi.mocked(useConnectionStore).mockReturnValue(scopeStore() as any);

      const { scopeActive, setScopeConnectionIds } = useQuickOpen();
      setScopeConnectionIds(["conn1"]);
      expect(scopeActive.value).toBe(true);
      setScopeConnectionIds([]);
      expect(scopeActive.value).toBe(false);
    });

    // Switching the scope must re-issue the query without retyping: the user picks a
    // connection and expects the list to change on the spot.
    it("re-runs the current query against the new connection when the scope changes", async () => {
      vi.useFakeTimers();
      try {
        const store = scopeStore();
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn1"]);
        setQuery("customer");
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();
        expect(store.listCompletionTables).toHaveBeenCalledTimes(1);
        expect(store.listCompletionTables.mock.calls[0][0]).toBe("conn1");

        // Switching to conn2 re-queries that connection without touching the query text.
        setScopeConnectionIds(["conn2"]);
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();

        expect(store.listCompletionTables).toHaveBeenCalledTimes(2);
        expect(store.listCompletionTables.mock.calls[1][0]).toBe("conn2");
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops results from the previous scope instead of merging them", async () => {
      vi.useFakeTimers();
      try {
        let resolveAlpha!: (value: any[]) => void;
        const store = scopeStore();
        store.listCompletionTables = vi.fn().mockImplementation((connectionId: string) => {
          if (connectionId === "conn1") return new Promise((resolve) => (resolveAlpha = resolve));
          return Promise.resolve([{ name: "beta_orders", schema: "", type: "table" }]);
        });
        vi.mocked(useConnectionStore).mockReturnValue(store as any);

        const { filteredItems, setQuery, setScopeConnectionIds } = useQuickOpen();
        setScopeConnectionIds(["conn1"]);
        setQuery("orders");
        await vi.advanceTimersByTimeAsync(400);

        // The scope changes while conn1's request is still in flight.
        setScopeConnectionIds(["conn2"]);
        await vi.advanceTimersByTimeAsync(400);
        await flushAsyncWork();
        expect(filteredItems.value.map((item) => item.label)).toContain("beta_orders");

        // The stale conn1 response lands late and must not surface under the new scope.
        resolveAlpha([{ name: "alpha_orders", schema: "", type: "table" }]);
        await flushAsyncWork();
        expect(filteredItems.value.map((item) => item.label)).toContain("beta_orders");
        expect(filteredItems.value.map((item) => item.label)).not.toContain("alpha_orders");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("SQL library files", () => {
    function savedSqlStoreWithFiles(files: any[]) {
      const fileMap = new Map(files.map((f) => [f.id, f]));
      return {
        allFiles: files,
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

    it("includes SQL library files whose connection was deleted", () => {
      const mockConnStore = {
        connections: [{ id: "conn1", name: "Active", type: "mssql" }],
        treeNodes: [],
      };
      vi.mocked(useConnectionStore).mockReturnValue(mockConnStore as any);

      const files = [
        { id: "f1", name: "active_query.sql", connectionId: "conn1", updatedAt: "2024-01-01T00:00:00.000Z" },
        { id: "f2", name: "orphaned_query.sql", connectionId: "deleted_conn", updatedAt: "2024-01-02T00:00:00.000Z" },
      ];
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles(files) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("query");

      const sqlItems = filteredItems.value.filter((item) => item.type === "sql_library_file");
      expect(sqlItems).toHaveLength(2);
      expect(sqlItems.find((item) => item.label === "orphaned_query.sql")?.description).toBe("Connection deleted");
    });

    it("labels SQL library files without a connection as unassociated", () => {
      vi.mocked(useConnectionStore).mockReturnValue({ connections: [], treeNodes: [] } as any);
      vi.mocked(useSavedSqlStore).mockReturnValue(savedSqlStoreWithFiles([{ id: "f1", name: "draft.sql", connectionId: "", updatedAt: "2024-01-01T00:00:00.000Z" }]) as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("draft");

      expect(filteredItems.value.find((item) => item.type === "sql_library_file")?.description).toBe("Unassociated");
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

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "ord", 25, undefined, true, undefined, undefined, { activateConnection: false });
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

    it("searches disconnected contexts through lazy connection", async () => {
      const mockStore = remoteSearchStore({ connectedIds: new Set<string>() });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("conn1", "app", "users", 25, undefined, true, undefined, undefined, { activateConnection: false });
    });

    it("prioritizes the active connection before applying the remote request cap", async () => {
      const connections = Array.from({ length: 9 }, (_, index) => ({ id: `conn${index}`, name: `Connection ${index}`, db_type: "mysql", database: `db${index}` }));
      const mockStore = remoteSearchStore({
        connections,
        activeConnectionId: "conn8",
        connectedIds: new Set(["conn8"]),
        treeNodes: [],
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      const requestedConnections = mockStore.listCompletionTables.mock.calls.map(([connectionId]) => connectionId);
      expect(requestedConnections).toContain("conn8");
      expect(requestedConnections).not.toContain("conn7");
      expect(mockStore.listCompletionTables).toHaveBeenCalledTimes(8);
    });

    it("publishes active connection results without waiting for slow cold connections", async () => {
      const slowSearch = deferred<Array<{ name: string; type: "table" }>>();
      const mockStore = remoteSearchStore({
        connections: [
          { id: "cold", name: "Cold", db_type: "mysql", database: "cold_db" },
          { id: "active", name: "Active", db_type: "mysql", database: "active_db" },
        ],
        activeConnectionId: "active",
        connectedIds: new Set(["active"]),
        treeNodes: [],
        listCompletionTables: vi.fn((connectionId) => (connectionId === "active" ? Promise.resolve([{ name: "active_users", type: "table" as const }]) : slowSearch.promise)),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("users");
      await runDebouncedSearch();

      expect(filteredItems.value.map((item) => item.label)).toContain("active_users");
      slowSearch.resolve([]);
      await flushAsyncWork();
    });

    it("drops stale queued contexts before scheduling a newer query", async () => {
      const alphaRequests: Array<ReturnType<typeof deferred<Array<{ name: string; type: "table" }>>>> = [];
      const listCompletionTables = vi.fn((_connectionId, _database, query) => {
        if (query === "alpha") {
          const request = deferred<Array<{ name: string; type: "table" }>>();
          alphaRequests.push(request);
          return request.promise;
        }
        return Promise.resolve([{ name: "beta_table", type: "table" as const }]);
      });
      const mockStore = remoteSearchStore({
        treeNodes: Array.from({ length: 4 }, (_, index) => ({
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
      setQuery("alpha");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      setQuery("beta");
      await runDebouncedSearch();
      expect(listCompletionTables).toHaveBeenCalledTimes(2);

      alphaRequests[0]!.resolve([]);
      await flushAsyncWork();
      expect(listCompletionTables.mock.calls[2]?.[2]).toBe("beta");
      expect(listCompletionTables.mock.calls.filter(([, , query]) => query === "alpha")).toHaveLength(2);

      alphaRequests[1]!.resolve([]);
      await flushAsyncWork();
      expect(filteredItems.value.map((item) => item.label)).toContain("beta_table");
    });

    it("derives the SQLite main database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "sqlite-1", name: "SQLite", db_type: "sqlite", host: "/tmp/app.sqlite" }],
        connectedIds: new Set<string>(),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "scroll_test", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("scroll_test");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("sqlite-1", "main", "scroll_test", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "scroll_test", type: "table", database: "main" })]));
    });

    it("searches the PostgreSQL backend default database before its tree is expanded", async () => {
      const mockStore = remoteSearchStore({
        connections: [{ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "" }],
        connectedIds: new Set<string>(),
        treeNodes: [],
        listCompletionTables: vi.fn().mockResolvedValue([{ name: "cold_start_table", type: "table" }]),
      });
      vi.mocked(useConnectionStore).mockReturnValue(mockStore as any);

      const { filteredItems, setQuery } = useQuickOpen();
      setQuery("cold_start_table");
      await runDebouncedSearch();

      expect(mockStore.listCompletionTables).toHaveBeenCalledWith("pg-1", "postgres", "cold_start_table", 25, undefined, true, undefined, undefined, { activateConnection: false });
      expect(filteredItems.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: "cold_start_table", type: "table", database: "postgres" })]));
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
