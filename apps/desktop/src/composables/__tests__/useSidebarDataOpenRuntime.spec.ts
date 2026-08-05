import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";
import type { QueryTab, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  databaseType: "oceanbase" as string,
  callOrder: [] as string[],
  tabs: [] as QueryTab[],
  activeTabId: null as string | null,
  cachedMetadata: undefined as unknown,
  dataTabReuseMode: "same-table" as DataTabReuseMode,
  ensureConnected: vi.fn(),
  executeTabSql: vi.fn(),
  loadTableMetadata: vi.fn(),
  buildTableSelectSql: vi.fn(),
  setErrorResult: vi.fn(),
  cancelTabExecution: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "connection-1", db_type: mocks.databaseType }),
    ensureConnected: mocks.ensureConnected,
    connectionIdentifierQuote: () => undefined,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    tabs: mocks.tabs,
    get activeTabId() {
      return mocks.activeTabId;
    },
    createTab: (connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string, _initialSql?: string, catalog?: string, options: { forceNew?: boolean } = {}) => {
      if (!options.forceNew) {
        const existing = mocks.tabs.find((tab) => tab.connectionId === connectionId && tab.database === database && tab.title === title && tab.mode === mode && (tab.schema || "") === (schema || "") && (tab.catalog || "") === (catalog || ""));
        if (existing) {
          mocks.activeTabId = existing.id;
          return existing.id;
        }
      }
      const tab = {
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
      } as QueryTab;
      mocks.tabs.push(tab);
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
        // 与真实 store 一致：仅真实元数据（columns 非空）落地才结束行标识等待
        if (tableMeta.columns.length > 0) tab.tableMetaPending = false;
      }
    },
    updateSql: (id: string, sql: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) tab.sql = sql;
    },
    executeTabSql: mocks.executeTabSql,
    setErrorResult: mocks.setErrorResult,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { dataTabReuseMode: mocks.dataTabReuseMode, pageSize: 100 } }),
}));

vi.mock("@/lib/database/jdbcDialect", () => ({
  effectiveDatabaseTypeForConnection: () => mocks.databaseType,
  connectionObjectTreeNodeSchema: (_config: unknown, _database: string, schema?: string) => schema,
  connectionObjectTreeQuerySchema: (_config: unknown, database: string, schema?: string) => schema ?? database,
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
vi.mock("@/lib/table/tableSelectSql", () => ({ buildTableSelectSql: mocks.buildTableSelectSql }));
vi.mock("@/lib/table/tableEditing", () => ({ usesSyntheticRowIdKey: () => false }));
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
    mocks.callOrder.length = 0;
    mocks.tabs.length = 0;
    mocks.activeTabId = null;
    mocks.cachedMetadata = undefined;
    mocks.dataTabReuseMode = "same-table";
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM users");
    mocks.executeTabSql.mockImplementation(async () => {
      mocks.callOrder.push("query");
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

  it("creates a new sidebar tab for the same table in always-new mode", async () => {
    mocks.dataTabReuseMode = "always-new";

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(2);
  });

  it("reuses a sidebar tab for the same table in same-table mode", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(1);
  });

  it("keeps different sidebar tables independent in same-table mode", async () => {
    const ordersNode = { ...tableNode, id: "table-orders", label: "orders" };

    await useSidebarDataOpenRuntime().openData(tableNode);
    await useSidebarDataOpenRuntime().openData(ordersNode);

    expect(mocks.tabs).toHaveLength(2);
    expect(mocks.tabs.map((tab) => tab.title)).toEqual(["users", "orders"]);
  });

  it("reuses the active safe data tab for a different table in active-tab mode", async () => {
    mocks.dataTabReuseMode = "active-tab";
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
    await useSidebarDataOpenRuntime().openData(ordersNode);

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.tabs[0]?.title).toBe("orders");
    expect(mocks.tabs[0]?.tableMeta?.tableName).toBe("orders");
  });

  it.each([
    ["pinned", { pinned: true }],
    ["executing", { isExecuting: true, executionId: "running" }],
    ["pending edits", { pendingDataChangeCount: 1 }],
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

  it("starts cold-cache OceanBase metadata before the table query", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["metadata", "query"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });

  it("keeps Dameng metadata deferred until after the table query", async () => {
    mocks.databaseType = "dameng";

    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["query", "metadata"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
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
    } as QueryTab);
    mocks.activeTabId = null;

    await useSidebarDataOpenRuntime().openData(tableNode);

    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.activeTabId).toBe("existing-tab");
    expect(mocks.cancelTabExecution).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).not.toHaveBeenCalled();
    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
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
});
