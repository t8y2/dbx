import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import { markRowIdLocatorUnsupported, resetRowIdLocatorStateForTests, rowIdLocatorUnsupported } from "@/lib/table/tableRowIdSupport";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";
import type { QueryTab, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  databaseType: "oceanbase" as string,
  tableOpenSortMode: "none" as "none" | "database" | "local",
  sortTabResultLocally: vi.fn(),
  callOrder: [] as string[],
  tabs: [] as QueryTab[],
  activeTabId: null as string | null,
  cachedMetadata: undefined as unknown,
  dataTabReuseMode: "same-table" as DataTabReuseMode,
  openDataTabsNextToActive: false,
  metadataGeneration: 0,
  includeSyntheticRowId: false,
  ensureConnected: vi.fn(),
  warmConnection: vi.fn(),
  executeTabSql: vi.fn(),
  loadTableMetadata: vi.fn(),
  buildTableSelectSql: vi.fn(),
  setErrorResult: vi.fn(),
  cancelTabExecution: vi.fn(),
  tauriRuntime: true,
  openTablesInDetachedWindow: false,
  detachDispatch: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "connection-1", db_type: mocks.databaseType }),
    ensureConnected: mocks.ensureConnected,
    warmConnection: mocks.warmConnection,
    connectionIdentifierQuote: () => undefined,
    metadataGenerationFor: () => mocks.metadataGeneration,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    tabs: mocks.tabs,
    get activeTabId() {
      return mocks.activeTabId;
    },
    createTab: (connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string, _initialSql?: string, catalog?: string, options: { forceNew?: boolean; insertAfterActive?: boolean } = {}) => {
      if (!options.forceNew) {
        const existing = mocks.tabs.find((tab) => tab.connectionId === connectionId && tab.database === database && tab.title === title && tab.mode === mode && (tab.schema || "") === (schema || "") && (tab.catalog || "") === (catalog || ""));
        if (existing) {
          mocks.activeTabId = existing.id;
          return existing.id;
        }
      }
      // 与真实 store 一致：tab 是响应式对象，settle watcher 才能观察到
      // isExecuting/result 的变化（#13308 detached open 依赖此行为）。
      const tab = reactive({
        id: `tab-${mocks.tabs.length + 1}`,
        connectionId,
        database,
        title,
        mode,
        schema,
        catalog,
        sql: "",
        isDirty: false,
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      }) as QueryTab;
      const activeIndex = options.insertAfterActive ? mocks.tabs.findIndex((item) => item.id === mocks.activeTabId) : -1;
      if (activeIndex >= 0) mocks.tabs.splice(activeIndex + 1, 0, tab);
      else mocks.tabs.push(tab);
      mocks.activeTabId = tab.id;
      return tab.id;
    },
    switchTab: vi.fn((id: string) => {
      mocks.activeTabId = id;
    }),
    cancelTabExecution: mocks.cancelTabExecution,
    setExecutingWithId: (id: string, executionId: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.isExecuting = true;
        tab.executionId = executionId;
      }
    },
    setTableMeta: (id: string, tableMeta: NonNullable<QueryTab["tableMeta"]>) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.tableMeta = tableMeta;
        // 与真实 store 一致：记录写入时的连接元数据代次
        tab.tableMetaGeneration = mocks.metadataGeneration;
        tab.tableMetaUpdatedAt = Date.now();
        // 与真实 store 一致：仅真实元数据（columns 非空）落地才结束行标识等待
        if (tableMeta.columns.length > 0) tab.tableMetaPending = false;
      }
    },
    updateSql: (id: string, sql: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) tab.sql = sql;
    },
    executeTabSql: mocks.executeTabSql,
    sortTabResultLocally: mocks.sortTabResultLocally,
    setErrorResult: mocks.setErrorResult,
    requestGridRevealColumn: vi.fn((tabId: string, columnName: string) => {
      const tab = mocks.tabs.find((item) => item.id === tabId);
      if (tab) {
        tab.gridRevealColumnRequest = { id: 1, columnName };
      }
    }),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      tableOpenSortMode: mocks.tableOpenSortMode,
      tableDatabaseSortDirection: "desc",
      tableLocalSortDirection: "asc",
      dataTabReuseMode: mocks.dataTabReuseMode,
      openDataTabsNextToActive: mocks.openDataTabsNextToActive,
      openTablesInDetachedWindow: mocks.openTablesInDetachedWindow,
      pageSize: 100,
    },
  }),
}));

vi.mock("@/stores/tunnelProfileStore", () => ({
  useTunnelProfileStore: () => ({ profileById: () => undefined }),
}));

// The detached-open settle logic itself is the real implementation; only the
// desktop gate and the dispatch destination are rerouted so the watcher's
// behavior stays observable in the node test environment.
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.tauriRuntime }));

vi.mock("@/lib/tabs/detachedTableOpen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tabs/detachedTableOpen")>();
  return {
    ...actual,
    requestDetachedTableOpen: (getTab: () => QueryTab | undefined) => actual.requestDetachedTableOpen(getTab, mocks.detachDispatch),
  };
});

vi.mock("@/lib/database/jdbcDialect", () => ({
  effectiveDatabaseTypeForConnection: () => mocks.databaseType,
  connectionObjectTreeNodeSchema: (_config: unknown, _database: string, schema?: string) => schema,
  connectionObjectTreeQuerySchema: (_config: unknown, database: string, schema?: string) => schema ?? database,
  connectionTableSqlSchema: (_config: unknown, schema?: string) => schema,
}));

vi.mock("@/lib/metadata/tableMetadataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata/tableMetadataCache")>();
  return {
    ...actual,
    getCachedTableMetadata: () => mocks.cachedMetadata,
    loadTableMetadata: mocks.loadTableMetadata,
  };
});

vi.mock("@/lib/common/utils", () => ({ uuid: () => "open-data-id" }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
// dataTabOpenPolicy 使用真实实现，覆盖设置开关对应的复用范围
vi.mock("@/lib/sidebar/treeNodeContext", () => ({ hasTreeNodeDatabaseContext: () => true }));
vi.mock("@/lib/table/tableSelectSql", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/table/tableSelectSql")>()), buildTableSelectSql: mocks.buildTableSelectSql }));
vi.mock("@/lib/table/tableEditing", () => ({
  DBX_ROWID_COLUMN: "__DBX_ROWID",
  physicalTablePrimaryKeys: (columns: Array<{ name: string; is_primary_key: boolean }>, indexes: Array<{ columns: string[]; is_primary: boolean }> = []) => {
    const columnPrimaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
    return columnPrimaryKeys.length > 0 ? columnPrimaryKeys : (indexes.find((index) => index.is_primary && index.columns.length > 0)?.columns ?? []);
  },
  usesSyntheticRowIdKey: () => false,
  shouldIncludeSyntheticRowId: () => mocks.includeSyntheticRowId,
}));
vi.mock("@/lib/table/tableOpenPageLimit", () => ({ tableOpenPageLimit: () => 100 }));
vi.mock("@/lib/tabs/dataTabActivation", () => ({ canActivateExistingDataTableTab: () => false }));

const tableNode: TreeNode = {
  id: "table-users",
  label: "users",
  type: "table",
  connectionId: "connection-1",
  database: "app",
  schema: "public",
  tableType: "TABLE",
};

const mysqlTableNode: TreeNode = {
  ...tableNode,
  id: "table-zcyy-write-off-record",
  label: "zcyy_write_off_record",
  database: "yf_db",
  schema: undefined,
};

describe("useSidebarDataOpenRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.databaseType = "oceanbase";
    mocks.tableOpenSortMode = "none";
    mocks.callOrder.length = 0;
    mocks.tabs.length = 0;
    mocks.activeTabId = null;
    mocks.cachedMetadata = undefined;
    mocks.dataTabReuseMode = "same-table";
    mocks.openDataTabsNextToActive = false;
    mocks.metadataGeneration = 0;
    mocks.includeSyntheticRowId = false;
    mocks.tauriRuntime = true;
    mocks.openTablesInDetachedWindow = false;
    resetRowIdLocatorStateForTests();
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM users");
    mocks.executeTabSql.mockImplementation(async (tabId: string) => {
      mocks.callOrder.push("query");
      const tab = mocks.tabs.find((candidate) => candidate.id === tabId);
      if (tab) {
        tab.isExecuting = false;
        tab.executionId = undefined;
      }
      return true;
    });
    mocks.loadTableMetadata.mockImplementation(async () => {
      mocks.callOrder.push("metadata");
      return {
        metadata: {
          schema: "public",
          tableName: "users",
          tableType: "TABLE",
          database: "app",
          columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
          indexes: [],
          primaryKeys: ["id"],
          cachedAt: Date.now(),
        },
        cacheStatus: "miss",
        ageMs: 0,
      };
    });
  });

  it.each(["database", "local"] as const)("applies the %s default using its independent direction", async (mode) => {
    mocks.tableOpenSortMode = mode;
    mocks.executeTabSql.mockImplementation(async () => {
      const tab = mocks.tabs[0]!;
      tab.isExecuting = false;
      tab.executionId = undefined;
      tab.result = { columns: ["id"], rows: [[2], [1]], affected_rows: 0, execution_time_ms: 0 } as any;
    });
    await useSidebarDataOpenRuntime().openData(tableNode);
    if (mode === "database") {
      expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: '"id" DESC' }));
      expect(mocks.tabs[0]).toMatchObject({ resultSortColumn: "id", resultSortDirection: "desc", resultSortMode: "database" });
    } else {
      expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: undefined }));
      expect(mocks.sortTabResultLocally).toHaveBeenCalledWith("tab-1", "id", 0, "asc");
    }
  });

  it("applies database sorting from a physical primary index when columns omit the key flag", async () => {
    mocks.databaseType = "oracle";
    mocks.tableOpenSortMode = "database";
    mocks.loadTableMetadata.mockResolvedValue({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
        indexes: [{ name: "users_pk", columns: ["id"], is_unique: true, is_primary: true }],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: '"id" DESC' }));
    expect(mocks.tabs[0]?.tableMeta?.physicalPrimaryKeys).toEqual(["id"]);
  });

  it("creates a new sidebar tab for the same table in always-new mode", async () => {
    mocks.dataTabReuseMode = "always-new";

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(2);
  });

  it("prewarms the tab session pool before the first page is fetched", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode);

    const createdTab = mocks.tabs[0]!;
    // The tab executes on its own session pool; warming it up front keeps the
    // connection setup off the critical path of the visible loading spinner.
    expect(mocks.warmConnection).toHaveBeenCalledWith("connection-1", {
      database: "app",
      catalog: undefined,
      clientSessionId: createdTab.id,
    });
  });

  it("does not let a stale row-id fallback overwrite a newer navigation", async () => {
    mocks.databaseType = "postgres";
    mocks.includeSyntheticRowId = true;
    mocks.loadTableMetadata.mockResolvedValue({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [{ name: "value", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
        indexes: [],
        primaryKeys: [],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });
    const locatorSql = 'SELECT tableoid::text AS "__DBX_ROWID", * FROM public.users';
    const fallbackSql = "SELECT * FROM public.users";
    let releaseFallbackSql!: (sql: string) => void;
    mocks.buildTableSelectSql.mockResolvedValueOnce(locatorSql).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFallbackSql = resolve;
      }),
    );
    mocks.executeTabSql.mockImplementationOnce(async (tabId: string, sql: string) => {
      const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
      tab.lastExecutedSql = sql;
      tab.result = { columns: ["Error"], rows: [["column tableoid does not exist"]], affected_rows: 0, execution_time_ms: 1, execution_error: true } as any;
      tab.resultViewGeneration = "failed-locator";
      tab.isExecuting = false;
      tab.executionId = undefined;
      return true;
    });

    let current = true;
    const request = {
      isCurrent: () => current,
      signal: new AbortController().signal,
      registerCancel: () => {},
    };
    const open = useSidebarDataOpenRuntime().openData(tableNode, request);
    await vi.waitFor(() => expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(2));
    const tab = mocks.tabs[0]!;
    current = false;
    tab.sql = "SELECT 'newer'";
    tab.lastExecutedSql = "SELECT 'newer'";
    tab.result = { columns: ["newer"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 } as any;
    tab.resultViewGeneration = "newer-result";

    releaseFallbackSql(fallbackSql);
    await open;

    expect(tab.sql).toBe("SELECT 'newer'");
    expect(tab.result?.columns).toEqual(["newer"]);
    expect(mocks.executeTabSql).toHaveBeenCalledTimes(1);
    expect(rowIdLocatorUnsupported("connection-1")).toBe(false);
  });

  it("does not start a row-id fallback when the failed execution was superseded before publishing", async () => {
    mocks.databaseType = "postgres";
    mocks.includeSyntheticRowId = true;
    const locatorSql = 'SELECT tableoid::text AS "__DBX_ROWID", * FROM public.users';
    mocks.buildTableSelectSql.mockResolvedValue(locatorSql);
    let releaseFailedExecution!: (published: boolean) => void;
    mocks.executeTabSql.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFailedExecution = resolve;
      }),
    );
    let current = true;
    const request = {
      isCurrent: () => current,
      signal: new AbortController().signal,
      registerCancel: () => {},
    };

    const open = useSidebarDataOpenRuntime().openData(tableNode, request);
    await vi.waitFor(() => expect(mocks.executeTabSql).toHaveBeenCalledTimes(1));
    const tab = mocks.tabs[0]!;
    current = false;
    tab.sql = "SELECT 'newer'";
    tab.result = { columns: ["newer"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 } as any;
    tab.resultViewGeneration = "newer-result";
    tab.isExecuting = false;
    tab.executionId = undefined;
    releaseFailedExecution(false);
    await open;

    expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1);
    expect(mocks.executeTabSql).toHaveBeenCalledTimes(1);
    expect(tab.sql).toBe("SELECT 'newer'");
    expect(rowIdLocatorUnsupported("connection-1")).toBe(false);
  });

  it("still lands preparation failures while the flow owns the tab", async () => {
    mocks.ensureConnected.mockRejectedValue(new Error("connection refused"));

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.setErrorResult).toHaveBeenCalledTimes(1);
    expect(mocks.setErrorResult).toHaveBeenCalledWith("tab-1", expect.any(Error));
  });

  it("does not land a late ensure-connected failure over a newer execution on the same tab", async () => {
    let rejectEnsureConnected!: (error: unknown) => void;
    mocks.ensureConnected.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectEnsureConnected = reject;
        }),
    );

    const open = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => expect(mocks.ensureConnected).toHaveBeenCalledTimes(1));
    const tab = mocks.tabs[0]!;
    // 同页签的手动执行接管：替换 executionId 并进入执行态，导航代次不变
    tab.executionId = "newer-execution";
    tab.isExecuting = true;

    rejectEnsureConnected(new Error("old preparation failed"));
    await open;

    expect(mocks.setErrorResult).not.toHaveBeenCalled();
    expect(tab.executionId).toBe("newer-execution");
    expect(tab.isExecuting).toBe(true);
  });

  it("does not land a late first-SQL-build failure over a newer execution on the same tab", async () => {
    let rejectBuildOpenSql!: (error: unknown) => void;
    mocks.buildTableSelectSql.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectBuildOpenSql = reject;
        }),
    );

    const open = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1));
    const tab = mocks.tabs[0]!;
    tab.executionId = "newer-execution";
    tab.isExecuting = true;

    rejectBuildOpenSql(new Error("old preparation failed"));
    await open;

    expect(mocks.setErrorResult).not.toHaveBeenCalled();
    expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1);
    expect(tab.executionId).toBe("newer-execution");
    expect(tab.isExecuting).toBe(true);
  });

  it("retries an already-issued row-id query after another request caches the unsupported capability", async () => {
    mocks.databaseType = "postgres";
    mocks.includeSyntheticRowId = true;
    const locatorSql = 'SELECT tableoid::text AS "__DBX_ROWID", * FROM public.users';
    const fallbackSql = "SELECT * FROM public.users";
    mocks.buildTableSelectSql.mockResolvedValueOnce(locatorSql).mockResolvedValueOnce(fallbackSql);
    let releaseLocatorFailure!: () => void;
    mocks.executeTabSql
      .mockImplementationOnce(
        (tabId: string) =>
          new Promise<boolean>((resolve) => {
            releaseLocatorFailure = () => {
              const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
              tab.result = { columns: ["Error"], rows: [["column tableoid does not exist"]], affected_rows: 0, execution_time_ms: 1, execution_error: true } as any;
              tab.resultViewGeneration = "failed-locator";
              tab.isExecuting = false;
              tab.executionId = undefined;
              resolve(true);
            };
          }),
      )
      .mockImplementationOnce(async (tabId: string) => {
        const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
        tab.result = { columns: ["value"], rows: [["ok"]], affected_rows: 0, execution_time_ms: 1 } as any;
        tab.resultViewGeneration = "fallback-result";
        tab.isExecuting = false;
        tab.executionId = undefined;
        return true;
      });

    const open = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => expect(mocks.executeTabSql).toHaveBeenCalledTimes(1));
    markRowIdLocatorUnsupported("connection-1");
    releaseLocatorFailure();
    await open;

    expect(mocks.executeTabSql).toHaveBeenCalledTimes(2);
    expect(mocks.executeTabSql).toHaveBeenLastCalledWith("tab-1", fallbackSql, expect.any(Object));
    expect(mocks.tabs[0]?.result?.columns).toEqual(["value"]);
  });

  it("applies the default sort to a successful row-id fallback result", async () => {
    mocks.databaseType = "postgres";
    mocks.includeSyntheticRowId = true;
    mocks.tableOpenSortMode = "local";
    const locatorSql = 'SELECT tableoid::text AS "__DBX_ROWID", * FROM public.users';
    const fallbackSql = "SELECT * FROM public.users";
    mocks.buildTableSelectSql.mockResolvedValueOnce(locatorSql).mockResolvedValueOnce(fallbackSql);
    mocks.executeTabSql
      .mockImplementationOnce(async (tabId: string) => {
        const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
        tab.result = { columns: ["Error"], rows: [["column tableoid does not exist"]], affected_rows: 0, execution_time_ms: 1, execution_error: true } as any;
        tab.resultViewGeneration = "failed-locator";
        tab.isExecuting = false;
        tab.executionId = undefined;
        return true;
      })
      .mockImplementationOnce(async (tabId: string) => {
        const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
        tab.result = { columns: ["id"], rows: [[2], [1]], affected_rows: 0, execution_time_ms: 1 } as any;
        tab.resultViewGeneration = "fallback-result";
        tab.isExecuting = false;
        tab.executionId = undefined;
        return true;
      });

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs[0]?.sql).toBe(fallbackSql);
    expect(mocks.sortTabResultLocally).toHaveBeenCalledWith("tab-1", "id", 0, "asc");
  });

  it("keeps adjacent placement for every tab created in always-new mode", async () => {
    mocks.dataTabReuseMode = "always-new";
    mocks.openDataTabsNextToActive = true;
    mocks.tabs.push(
      { id: "query-1", connectionId: "connection-1", database: "app", title: "Query 1", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
      { id: "query-2", connectionId: "connection-1", database: "app", title: "Query 2", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
    );
    mocks.activeTabId = "query-1";

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["Query 1", "users", "users", "Query 2"]);
  });

  it("reuses a sidebar tab for the same table in same-table mode", async () => {
    mocks.openDataTabsNextToActive = true;

    await useSidebarDataOpenRuntime().openData({ ...tableNode, comment: "Old comment" });
    await useSidebarDataOpenRuntime().openData({ ...tableNode, comment: "Updated comment" });

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.tabs[0]?.tableComment).toBe("Updated comment");
  });

  it("copies the existing sidebar table comment without another metadata request", async () => {
    await useSidebarDataOpenRuntime().openData({ ...tableNode, comment: "Application users" });

    expect(mocks.tabs[0]?.tableComment).toBe("Application users");
    expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps different sidebar tables independent in same-table mode", async () => {
    const ordersNode = { ...tableNode, id: "table-orders", label: "orders" };

    await useSidebarDataOpenRuntime().openData({ ...tableNode, comment: "User table" });
    await useSidebarDataOpenRuntime().openData(ordersNode);

    expect(mocks.tabs).toHaveLength(2);
    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["users", "orders"]);
  });

  it("requests the detached open once after a fresh table tab's first load settles", async () => {
    mocks.openTablesInDetachedWindow = true;
    mocks.executeTabSql.mockImplementation(async (tabId: string) => {
      const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
      tab.isExecuting = false;
      tab.executionId = undefined;
      tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 } as any;
      return true;
    });

    await useSidebarDataOpenRuntime().openData(tableNode);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.detachDispatch).toHaveBeenCalledExactlyOnceWith({ tabId: "tab-1" });
  });

  it("detaches a reused tab only after the fresh reload settles, not on its stale errored result", async () => {
    mocks.openTablesInDetachedWindow = true;
    // First open fails: the same-table tab keeps the errored result and idles.
    mocks.executeTabSql.mockImplementation(async (tabId: string) => {
      const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
      tab.isExecuting = false;
      tab.executionId = undefined;
      tab.result = { columns: ["Error"], execution_error: true, rows: [["boom"]], affected_rows: 0, execution_time_ms: 0 } as any;
      return true;
    });
    await useSidebarDataOpenRuntime().openData(tableNode);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.tabs).toHaveLength(1);
    mocks.detachDispatch.mockClear();

    // Second open of the same table reuses the errored tab and reloads it.
    let resolveSecondLoad: ((publishResult: boolean) => void) | undefined;
    mocks.executeTabSql.mockImplementation((tabId: string) => {
      const tab = mocks.tabs.find((candidate) => candidate.id === tabId)!;
      return new Promise<boolean>((resolve) => {
        resolveSecondLoad = (publishResult: boolean) => {
          tab.isExecuting = false;
          tab.executionId = undefined;
          if (publishResult) {
            tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 } as any;
          }
          resolve(true);
        };
      });
    });

    const opened = useSidebarDataOpenRuntime().openData(tableNode);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stale errored result must not satisfy the settle check: no detach
    // while the fresh reload is still in flight.
    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.detachDispatch).not.toHaveBeenCalled();

    resolveSecondLoad!(true);
    await opened;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.detachDispatch).toHaveBeenCalledExactlyOnceWith({ tabId: "tab-1" });
  });

  it("opens a new table data tab next to the active tab when enabled", async () => {
    mocks.openDataTabsNextToActive = true;
    mocks.tabs.push(
      { id: "query-1", connectionId: "connection-1", database: "app", title: "Query 1", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
      { id: "query-2", connectionId: "connection-1", database: "app", title: "Query 2", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
    );
    mocks.activeTabId = "query-1";

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["Query 1", "users", "Query 2"]);
  });

  it("keeps appending new table data tabs when adjacent opening is disabled", async () => {
    mocks.tabs.push(
      { id: "query-1", connectionId: "connection-1", database: "app", title: "Query 1", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
      { id: "query-2", connectionId: "connection-1", database: "app", title: "Query 2", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
    );
    mocks.activeTabId = "query-1";

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 2", "users"]);
  });

  it("reuses the active safe data tab for a different table in active-tab mode", async () => {
    mocks.dataTabReuseMode = "active-tab";
    mocks.openDataTabsNextToActive = true;
    const ordersNode = { ...tableNode, id: "table-orders", label: "orders" };
    mocks.loadTableMetadata.mockImplementation(async (request: { database: string; schema?: string; tableName: string; tableType?: string }) => ({
      metadata: {
        schema: request.schema,
        tableName: request.tableName,
        tableType: request.tableType ?? "TABLE",
        database: request.database,
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));

    await useSidebarDataOpenRuntime().openData(tableNode);
    mocks.tabs[0]!.isExecuting = false;
    mocks.tabs[0]!.executionId = undefined;
    mocks.tabs[0]!.resultLocalSortOriginalLargeValueCells = [{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }];
    await useSidebarDataOpenRuntime().openData(ordersNode);

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.tabs[0]?.title).toBe("orders");
    expect(mocks.tabs[0]?.tableComment).toBeUndefined();
    expect(mocks.tabs[0]?.tableMeta?.tableName).toBe("orders");
    expect(mocks.tabs[0]?.resultLocalSortOriginalLargeValueCells).toBeUndefined();
  });

  it.each([
    ["pinned", { pinned: true }],
    ["executing", { isExecuting: true, executionId: "running" }],
    ["pending edits", { pendingDataChangeCount: 1 }],
    ["pending editor draft", { hasPendingDataEditorDraft: true }],
  ])("opens a new tab instead of replacing an active %s data tab", async (_label, patch) => {
    mocks.dataTabReuseMode = "active-tab";
    const activeTab = {
      id: "active-users",
      connectionId: "connection-1",
      database: "app",
      title: "users",
      mode: "data",
      schema: "public",
      sql: "SELECT * FROM users",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
      ...patch,
    } as QueryTab;
    mocks.tabs.push(activeTab);
    mocks.activeTabId = activeTab.id;

    await useSidebarDataOpenRuntime().openData({ ...tableNode, id: "table-orders", label: "orders" });

    expect(mocks.tabs).toHaveLength(2);
    expect(mocks.tabs[0]?.title).toBe("users");
    expect(mocks.tabs[1]?.title).toBe("orders");
    expect(mocks.cancelTabExecution).not.toHaveBeenCalledWith(activeTab.id);
  });

  it("creates a new HBase tab for the same table in always-new mode", async () => {
    mocks.databaseType = "hbase";
    mocks.dataTabReuseMode = "always-new";

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(2);
  });

  it("keeps different HBase tables independent in same-table mode", async () => {
    mocks.databaseType = "hbase";

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData({ ...tableNode, id: "table-orders", label: "orders" });

    expect(mocks.tabs).toHaveLength(2);
  });

  it("opens a new HBase data tab next to the active tab when enabled", async () => {
    mocks.databaseType = "hbase";
    mocks.openDataTabsNextToActive = true;
    mocks.tabs.push(
      { id: "query-1", connectionId: "connection-1", database: "app", title: "Query 1", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
      { id: "query-2", connectionId: "connection-1", database: "app", title: "Query 2", mode: "query", sql: "", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab,
    );
    mocks.activeTabId = "query-1";

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["Query 1", "users", "Query 2"]);
  });

  it("starts cold-cache OceanBase metadata before the table query", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["metadata", "query"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });

  it.each(["nebula", "neo4j"])("waits for %s properties before building the first table query", async (databaseType) => {
    mocks.databaseType = databaseType;
    let releaseMetadata: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    mocks.loadTableMetadata.mockImplementation(async () => {
      await gate;
      return {
        metadata: {
          schema: "public",
          tableName: "users",
          tableType: "TABLE",
          database: "app",
          columns: [{ name: "name", data_type: "string", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
          indexes: [],
          primaryKeys: [],
          cachedAt: Date.now(),
        },
        cacheStatus: "miss",
        ageMs: 0,
      };
    });

    const opening = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => expect(mocks.loadTableMetadata).toHaveBeenCalled());
    expect(mocks.buildTableSelectSql).not.toHaveBeenCalled();
    releaseMetadata();
    await opening;

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType, columns: ["name"] }));
    expect(mocks.callOrder).toEqual(["query"]);
  });

  it("keeps Dameng metadata deferred until after the table query", async () => {
    mocks.databaseType = "dameng";

    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["query", "metadata"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });

  it("preserves JDBC table schema through the table-data request", async () => {
    mocks.databaseType = "jdbc";
    mocks.loadTableMetadata.mockImplementation(async (request: { database: string; schema?: string; tableName: string; tableType?: string }) => ({
      metadata: {
        schema: request.schema,
        tableName: request.tableName,
        tableType: request.tableType,
        database: request.database,
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));

    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]));
    expect(mocks.loadTableMetadata).toHaveBeenCalledWith(expect.objectContaining({ database: "app", schema: "public" }));
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ database: "app", schema: "public", tableName: "users" }));
    expect(mocks.tabs[0]?.tableMeta).toMatchObject({ database: "app", schema: "public", tableName: "users" });
  });

  it("keeps MySQL data-tab identity unqualified after metadata loads", async () => {
    mocks.databaseType = "mysql";
    mocks.loadTableMetadata.mockImplementation(async (request: { database: string; schema?: string; tableName: string; tableType?: string }) => ({
      metadata: {
        schema: request.schema,
        tableName: request.tableName,
        tableType: request.tableType,
        database: request.database,
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));

    await useSidebarDataOpenRuntime().openData(mysqlTableNode);

    await vi.waitFor(() => expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]));
    expect(mocks.loadTableMetadata).toHaveBeenCalledWith(expect.objectContaining({ database: "yf_db", schema: "yf_db" }));
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ database: "yf_db", schema: undefined, tableName: "zcyy_write_off_record" }));
    expect(mocks.tabs[0]?.tableMeta).toMatchObject({ database: "yf_db", schema: undefined, tableName: "zcyy_write_off_record" });
  });

  it("keeps cached MySQL table metadata unqualified", async () => {
    mocks.databaseType = "mysql";
    mocks.cachedMetadata = {
      metadata: {
        schema: "yf_db",
        tableName: "zcyy_write_off_record",
        tableType: "TABLE",
        database: "yf_db",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "hit",
      ageMs: 0,
    };

    await useSidebarDataOpenRuntime().openData(mysqlTableNode);

    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ database: "yf_db", schema: undefined, tableName: "zcyy_write_off_record" }));
    expect(mocks.tabs[0]?.tableMeta).toMatchObject({ database: "yf_db", schema: undefined, tableName: "zcyy_write_off_record" });
  });

  it("keeps row identity pending while delayed metadata is in flight and the query finishes first", async () => {
    // 元数据延迟：查询先返回，元数据仍挂起
    let releaseMetadata: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    mocks.loadTableMetadata.mockImplementation(async () => {
      mocks.callOrder.push("metadata-start");
      await gate;
      mocks.callOrder.push("metadata-done");
      return {
        metadata: {
          schema: "public",
          tableName: "users",
          tableType: "TABLE",
          database: "app",
          columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
          indexes: [],
          primaryKeys: ["id"],
          cachedAt: Date.now(),
        },
        cacheStatus: "miss",
        ageMs: 0,
      };
    });

    await useSidebarDataOpenRuntime().openData(tableNode);

    // 查询已完成、元数据尚未返回：行标识必须仍处于等待状态，
    // primaryKeys 为空不得被当作"确认无主键"（#3727 整行 WHERE 保存路径）
    expect(mocks.callOrder).toEqual(["metadata-start", "query"]);
    expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual([]);
    expect(mocks.tabs[0]?.tableMetaPending).toBe(true);

    releaseMetadata();
    await vi.waitFor(() => {
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
      expect(mocks.tabs[0]?.tableMetaPending).toBe(false);
    });
  });

  it("keeps the tab read-only when the metadata load fails", async () => {
    mocks.loadTableMetadata.mockRejectedValue(new Error("metadata failed"));

    await useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => {
      expect(mocks.loadTableMetadata).toHaveBeenCalled();
    });

    // 行标识仍然未知：保持只读兜底，不回退到整行 WHERE 写入；
    // 刷新或重开表会重试元数据加载并恢复可编辑
    expect(mocks.tabs[0]?.tableMetaPending).toBe(true);
    expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual([]);
  });

  it("keeps the superseded tab read-only when metadata never starts", async () => {
    // openData 在 ensureConnected 阶段被新请求取代：元数据请求不会启动
    let releaseConnect: () => void = () => {};
    mocks.ensureConnected.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    let current = true;
    const request = {
      isCurrent: () => current,
      signal: new AbortController().signal,
      registerCancel: () => {},
    };
    const open = useSidebarDataOpenRuntime().openData(tableNode, request);
    await vi.waitFor(() => {
      expect(mocks.ensureConnected).toHaveBeenCalled();
    });
    current = false;
    releaseConnect();
    await open;

    // 行标识从未确认：保持只读兜底；重开该表或刷新会重新加载元数据恢复
    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).not.toHaveBeenCalled();
    expect(mocks.tabs[0]?.tableMetaPending).toBe(true);
  });

  it("activates an already-running same-table tab without cancelling it", async () => {
    mocks.tabs.push({
      id: "existing-tab",
      connectionId: "connection-1",
      database: "app",
      title: "users",
      mode: "data",
      schema: "public",
      sql: "",
      isDirty: false,
      isExecuting: true,
      executionId: "stale-execution",
      isCancelling: false,
      isExplaining: false,
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        primaryKeys: ["id"],
      },
      tableMetaUpdatedAt: Date.now(),
      // 真实 tab 的 tableMeta 必经 setTableMeta 写入并记录当前代次（0）
      tableMetaGeneration: 0,
    } as QueryTab);
    mocks.activeTabId = null;

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.activeTabId).toBe("existing-tab");
    expect(mocks.cancelTabExecution).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).not.toHaveBeenCalled();
    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
  });

  it("repairs a restored Oracle view tab that was persisted as a table", async () => {
    mocks.databaseType = "oracle";
    const viewNode = { ...tableNode, id: "view-users", type: "view" as const, tableType: undefined };
    mocks.tabs.push({
      id: "existing-view-tab",
      connectionId: "connection-1",
      database: "app",
      title: "users",
      mode: "data",
      schema: "public",
      sql: "SELECT * FROM users",
      isDirty: false,
      isExecuting: true,
      executionId: "running-query",
      isCancelling: false,
      isExplaining: false,
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
        primaryKeys: ["__DBX_ROWID"],
      },
      tableMetaUpdatedAt: Date.now(),
      tableMetaGeneration: 0,
    } as QueryTab);
    mocks.loadTableMetadata.mockImplementationOnce(async (request: { database: string; schema?: string; tableName: string; tableType?: string }) => ({
      metadata: {
        schema: request.schema,
        tableName: request.tableName,
        tableType: request.tableType,
        database: request.database,
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
        indexes: [],
        primaryKeys: [],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));

    await useSidebarDataOpenRuntime().openData(viewNode);

    expect(mocks.tabs[0]?.tableMeta?.tableType).toBe("VIEW");
    expect(mocks.cancelTabExecution).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.loadTableMetadata).toHaveBeenCalledWith(expect.objectContaining({ tableName: "users", tableType: "VIEW" }));
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual([]);
    });
  });

  it("does not mark row identity pending on a warm metadata cache", async () => {
    mocks.cachedMetadata = {
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "hit",
      ageMs: 0,
    };

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    expect(mocks.tabs[0]?.tableMetaPending).toBeFalsy();
    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
  });

  it("keeps tab-local metadata warm within the TTL window (no reload on reopen)", async () => {
    const reload = vi.fn();
    mocks.loadTableMetadata.mockImplementation(async () => {
      reload();
      return {
        metadata: {
          schema: "public",
          tableName: "users",
          tableType: "TABLE",
          database: "app",
          columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
          indexes: [],
          primaryKeys: ["id"],
          cachedAt: Date.now(),
        },
        cacheStatus: "miss",
        ageMs: 0,
      };
    });

    await useSidebarDataOpenRuntime().openData(tableNode);
    // 第一次打开已把 tab-local tableMetaUpdatedAt 置为新鲜
    expect(mocks.tabs[0]?.tableMetaUpdatedAt).toBeDefined();
    // 复位执行态，让第二次打开走重开（reuse）路径而非 activate 早退
    mocks.tabs[0]!.isExecuting = false;
    mocks.tabs[0]!.executionId = undefined;

    // 未发生连接生命周期变化：TTL 窗口内重开同表直接复用 tab-local 元数据
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.tabs[0]?.tableMeta?.tableName).toBe("users");
  });

  it("reloads tab metadata after a reconnect boundary (issue #6623 reconnect regression)", async () => {
    // 第一次打开的元数据：[id]
    await useSidebarDataOpenRuntime().openData(tableNode);
    expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.tabs[0]?.tableMeta?.columns.map((column) => column.name)).toEqual(["id"]);
    expect(mocks.tabs[0]?.tableMetaUpdatedAt).toBeDefined();

    // 外部 ALTER TABLE ... ADD age：DBX 断开→重连。断开时 connectionStore 会
    // 清掉该连接下数据标签页的 freshness 戳（staleConnectionDataTabMetadata），
    // 此处等价模拟该生命周期边界。
    mocks.tabs[0]!.tableMetaUpdatedAt = undefined;
    mocks.tabs[0]!.isExecuting = false;
    mocks.tabs[0]!.executionId = undefined;

    // 第二次打开（重连后）：即使处于原 30s TTL 窗口内，也必须重新拉取结构
    mocks.loadTableMetadata.mockImplementationOnce(async () => ({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [
          { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "age", data_type: "integer", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    }));
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(mocks.tabs[0]?.tableMeta?.columns.map((column) => column.name)).toContain("age");
    });
  });

  it("does not write stale in-flight metadata back to the tab after a disconnect boundary", async () => {
    // 手动挂起的元数据加载：openData 启动后台加载后停留在 in-flight
    let resolveMetadata!: (value: Awaited<ReturnType<typeof mocks.loadTableMetadata>>) => void;
    const pendingMetadata = new Promise<Awaited<ReturnType<typeof mocks.loadTableMetadata>>>((resolve) => {
      resolveMetadata = resolve;
    });
    mocks.loadTableMetadata.mockReturnValueOnce(pendingMetadata);

    const openPromise = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => {
      expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(1);
    });

    // 模拟 disconnect 生命周期边界：连接代次递增 + freshness 戳被清
    // （staleConnectionDataTabMetadata）
    mocks.metadataGeneration = 1;
    mocks.tabs[0]!.tableMetaUpdatedAt = undefined;

    // 旧连接在途的结果此时才返回：shared 缓存写回已被 per-scope 失效代数
    // 挡住，tab-local 写回必须被连接代次校验拦下（PR #6640 review blocker 1）
    resolveMetadata({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });
    await openPromise;
    await vi.waitFor(() => {
      expect(mocks.tabs[0]?.tableMetaUpdatedAt).toBeUndefined();
    });

    // 占位元数据未被旧列覆盖：freshness 保持在失效后的"冷"状态
    expect(mocks.tabs[0]?.tableMeta?.columns).toEqual([]);
    expect(mocks.tabs[0]?.tableMetaGeneration).toBe(0);
  });

  it("requests grid column reveal when opening a table with revealColumn option", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode, undefined, "default", { revealColumn: "email" });

    expect(mocks.tabs[0]?.gridRevealColumnRequest).toEqual({ id: 1, columnName: "email" });
  });

  it("requests grid column reveal when activating an existing same-table tab with revealColumn option", async () => {
    mocks.dataTabReuseMode = "same-table";
    await useSidebarDataOpenRuntime().openData(tableNode);
    expect(mocks.tabs[0]?.gridRevealColumnRequest).toBeUndefined();

    await useSidebarDataOpenRuntime().openData(tableNode, undefined, "default", { revealColumn: "created_at" });
    expect(mocks.tabs[0]?.gridRevealColumnRequest).toEqual({ id: 1, columnName: "created_at" });
  });
});
