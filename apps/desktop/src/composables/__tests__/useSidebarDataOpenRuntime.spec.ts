import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import type { QueryTab, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  databaseType: "oceanbase" as string,
  callOrder: [] as string[],
  tabs: [] as QueryTab[],
  cachedMetadata: undefined as unknown,
  ensureConnected: vi.fn(),
  executeTabSql: vi.fn(),
  loadTableMetadata: vi.fn(),
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
    createTab: (connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string) => {
      const tab = {
        id: "tab-1",
        connectionId,
        database,
        title,
        mode,
        schema,
        sql: "",
        isDirty: false,
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      } as QueryTab;
      mocks.tabs.push(tab);
      return tab.id;
    },
    switchTab: vi.fn(),
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
  useSettingsStore: () => ({ editorSettings: { reuseDataTab: false, pageSize: 100 } }),
}));

vi.mock("@/lib/database/jdbcDialect", () => ({
  effectiveDatabaseTypeForConnection: () => mocks.databaseType,
  connectionObjectTreeNodeSchema: (_config: unknown, _database: string, schema?: string) => schema,
  connectionObjectTreeQuerySchema: (_config: unknown, _database: string, schema?: string) => schema ?? "",
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
// dataTabOpenPolicy 使用真实实现：beforeEach 清空 tabs 时无候选可复用，
// 取消窗口测试则依赖真实 findExistingDataTabCandidate 选中同表 tab
vi.mock("@/lib/sidebar/treeNodeContext", () => ({ hasTreeNodeDatabaseContext: () => true }));
vi.mock("@/lib/table/tableSelectSql", () => ({ buildTableSelectSql: async () => "SELECT * FROM users" }));
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

describe("useSidebarDataOpenRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.databaseType = "oceanbase";
    mocks.callOrder.length = 0;
    mocks.tabs.length = 0;
    mocks.cachedMetadata = undefined;
    mocks.ensureConnected.mockResolvedValue(undefined);
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

  it("aborts when a newer navigation takes over the tab during the cancel wait", async () => {
    const { beginDataTabNavigation } = await import("@/lib/tabs/dataTabNavigationGeneration");
    // 已存在同表 data tab 且有在途执行：真实 findExistingDataTabCandidate 会
    // 选中它（same-table 复用分支），openData 需先等待取消
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
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
    } as QueryTab);
    let releaseCancel: () => void = () => {};
    mocks.cancelTabExecution.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
    );
    const open = useSidebarDataOpenRuntime().openData(tableNode);
    await vi.waitFor(() => expect(mocks.cancelTabExecution).toHaveBeenCalledWith("existing-tab"));
    // 复用既有 tab，而非新建
    expect(mocks.tabs).toHaveLength(1);

    // 取消等待期间，更晚的导航（如 openTableTarget）接管该 tab
    beginDataTabNavigation("existing-tab");
    const takeoverMeta = { schema: "public", tableName: "other_table", tableType: "TABLE", columns: [], primaryKeys: [] };
    mocks.tabs[0]!.tableMeta = takeoverMeta;

    releaseCancel();
    await open;

    // 旧 openData 必须让位：不得覆盖新导航写入的身份，不得启动查询
    expect(mocks.tabs[0]?.tableMeta).toBe(takeoverMeta);
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
