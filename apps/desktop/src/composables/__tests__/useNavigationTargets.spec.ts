import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { clearTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import type { QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  tabs: [] as QueryTab[],
  activeTabId: "",
  databaseType: "postgres" as string,
  ensureConnected: vi.fn(),
  executeTabSql: vi.fn(),
  getColumns: vi.fn(),
  invalidateCompletionTableCache: vi.fn(),
  listIndexes: vi.fn(),
  setTableMeta: vi.fn(),
  updateSql: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    activeConnectionId: "",
    getConfig: () => ({ id: "connection-1", db_type: mocks.databaseType }),
    ensureConnected: mocks.ensureConnected,
    connectionIdentifierQuote: () => undefined,
    refreshObjectListTreeNode: vi.fn(),
    invalidateCompletionTableCache: mocks.invalidateCompletionTableCache,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    tabs: mocks.tabs,
    activeTabId: mocks.activeTabId,
    createTab: (connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string) => {
      const tab = {
        id: `tab-${mocks.tabs.length + 1}`,
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
    setExecuting: vi.fn(),
    setExecutingWithId: (id: string, executionId: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.isExecuting = true;
        tab.executionId = executionId;
      }
    },
    setTableMeta: mocks.setTableMeta.mockImplementation((id: string, meta: NonNullable<QueryTab["tableMeta"]>) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.tableMeta = meta;
        tab.tableMetaUpdatedAt = Date.now();
        // 与真实 store 一致：仅真实元数据（columns 非空）落地才结束行标识等待
        if (meta.columns.length > 0) tab.tableMetaPending = false;
      }
    }),
    updateSql: mocks.updateSql,
    executeTabSql: mocks.executeTabSql,
    setErrorResult: vi.fn(),
    invalidateTableStructure: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { reuseDataTab: true } }),
}));

vi.mock("@/lib/table/tableSelectSql", () => ({
  buildTableSelectSql: async ({ tableName }: { tableName: string }) => `SELECT * FROM ${tableName}`,
}));

const dialogs = {
  showFieldLineageDialog: { value: false },
  showDatabaseSearchDialog: { value: false },
  showDiagramDialog: { value: false },
};

function column(name: string) {
  return { name, data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null };
}

describe("useNavigationTargets openTableTarget", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    vi.clearAllMocks();
    mocks.tabs.length = 0;
    mocks.databaseType = "postgres";
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeTabSql.mockResolvedValue(undefined);
    mocks.getColumns.mockResolvedValue([column("id")]);
    mocks.listIndexes.mockResolvedValue([]);
  });

  it("marks row identity pending until real metadata lands", async () => {
    let releaseColumns: (columns: unknown[]) => void = () => {};
    mocks.getColumns.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseColumns = resolve;
      }),
    );
    let pendingDuringQuery: boolean | undefined;
    mocks.executeTabSql.mockImplementationOnce(async () => {
      pendingDuringQuery = mocks.tabs[0]?.tableMetaPending;
    });

    const open = useNavigationTargets(dialogs).openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });
    releaseColumns([column("id")]);
    await open;

    // 数据查询执行期间元数据未落地：行标识等待必须已挂起
    expect(pendingDuringQuery).toBe(true);
    expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    expect(mocks.tabs[0]?.tableMetaPending).toBe(false);
  });

  it("reuses cached metadata and force-refreshes it once per catalog after a structure save", async () => {
    const navigation = useNavigationTargets(dialogs);
    const target = { connectionId: "connection-1", database: "app", schema: "public", catalog: "catalog-1", tableName: "users" };

    await navigation.openLineageTarget(target);
    await navigation.openLineageTarget(target);
    expect(mocks.getColumns).toHaveBeenCalledTimes(1);

    mocks.getColumns.mockResolvedValueOnce([column("fresh_id")]);

    await navigation.onStructureEditorSaved(vi.fn().mockResolvedValue(undefined), vi.fn(), {
      connectionId: target.connectionId,
      database: target.database,
      schema: target.schema,
      catalog: target.catalog,
      tableName: target.tableName,
    });

    expect(mocks.invalidateCompletionTableCache).toHaveBeenCalledWith("connection-1", "app", "users", "public", "catalog-1");
    expect(mocks.getColumns).toHaveBeenCalledTimes(2);
    expect(mocks.tabs.map((tab) => tab.tableMeta?.primaryKeys)).toEqual([["fresh_id"], ["fresh_id"]]);
  });

  it("keeps row identity pending when shared metadata loading fails", async () => {
    mocks.getColumns.mockRejectedValueOnce(new Error("metadata unavailable"));

    await useNavigationTargets(dialogs).openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });

    expect(mocks.tabs[0]?.tableMeta?.columns).toEqual([]);
    expect(mocks.tabs[0]?.tableMetaPending).toBe(true);
  });

  it("uses the SQLite attached database as the table namespace when a target omits schema", async () => {
    mocks.databaseType = "sqlite";

    await useNavigationTargets(dialogs).openLineageTarget({ connectionId: "connection-1", database: "analytics", tableName: "events" });

    expect(mocks.tabs[0]?.schema).toBe("analytics");
    expect(mocks.tabs[0]?.tableMeta?.schema).toBe("analytics");
    expect(mocks.getColumns.mock.calls.some(([connectionId, database, schema, tableName]) => connectionId === "connection-1" && database === "analytics" && schema === "analytics" && tableName === "events")).toBe(true);
  });

  it("opens different targets in separate tabs even when sidebar data-tab reuse is enabled", async () => {
    const columnGates = new Map<string, (columns: unknown[]) => void>();
    mocks.getColumns.mockImplementation(
      (_connectionId: string, _database: string, _schema: string, tableName: string) =>
        new Promise((resolve) => {
          columnGates.set(tableName, resolve);
        }),
    );
    const navigation = useNavigationTargets(dialogs);
    const openA = navigation.openTableTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "table_a" });
    await vi.waitFor(() => expect(columnGates.has("table_a")).toBe(true));

    const openB = navigation.openTableTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "table_b" });
    await vi.waitFor(() => expect(columnGates.has("table_b")).toBe(true));
    expect(mocks.tabs).toHaveLength(2);
    expect(mocks.tabs.map((tab) => tab.tableMeta?.tableName)).toEqual(["table_a", "table_b"]);

    columnGates.get("table_a")?.([column("a_id")]);
    columnGates.get("table_b")?.([column("b_id")]);
    await Promise.all([openA, openB]);
    expect(mocks.tabs.map((tab) => tab.tableMeta?.primaryKeys)).toEqual([["a_id"], ["b_id"]]);
    expect(mocks.tabs.every((tab) => tab.tableMetaPending === false)).toBe(true);
  });

  it("stops landing when another entry point takes over the tab, even for the same table", async () => {
    const { beginDataTabNavigation } = await import("@/lib/tabs/dataTabNavigationGeneration");
    // A（openTableTarget）的 getColumns 挂起
    const columnGates = new Map<string, (columns: unknown[]) => void>();
    mocks.getColumns.mockImplementation(
      (_connectionId: string, _database: string, _schema: string, tableName: string) =>
        new Promise((resolve) => {
          columnGates.set(tableName, resolve);
        }),
    );
    const navigation = useNavigationTargets(dialogs);
    const openA = navigation.openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });
    await vi.waitFor(() => expect(columnGates.has("users")).toBe(true));
    mocks.setTableMeta.mockClear();

    // 侧边栏 openData 接管同一 tab（同表——目标身份校验无法区分）：登记新代次即作废旧代次
    beginDataTabNavigation(mocks.tabs[0]!.id);

    // 旧 A 晚返回：目标身份仍匹配，但代次已作废，不得落地元数据
    columnGates.get("users")?.([column("id")]);
    await openA;
    expect(mocks.setTableMeta).not.toHaveBeenCalled();
  });

  it("skips the tdengine requery when a cancel was requested during the first execute", async () => {
    // tdengine 无条件走元数据后的第二次查询。模拟：首次 executeTabSql 期间
    // 用户点击停止，但取消返回 false（查询先完成），isCancelling 被清、
    // 结果正常——重查仍然必须被跳过（不能替用户重跑他停掉的查询）
    mocks.databaseType = "tdengine";
    mocks.executeTabSql.mockImplementationOnce(async (id: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        // 用户在执行期间请求停止：计数单调递增；随后取消失败、状态被清
        tab.cancelRequestCount = (tab.cancelRequestCount ?? 0) + 1;
        tab.isCancelling = false;
        tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      }
    });

    await useNavigationTargets(dialogs).openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });

    // 只有首次执行；tdengine 重查被取消请求拦下，元数据仍正常落地
    expect(mocks.executeTabSql).toHaveBeenCalledTimes(1);
    expect(mocks.tabs[0]?.tableMeta?.columns.length).toBeGreaterThan(0);
  });

  it("runs the tdengine requery normally when no cancel was requested", async () => {
    mocks.databaseType = "tdengine";

    await useNavigationTargets(dialogs).openLineageTarget({ connectionId: "connection-1", database: "app", schema: "public", tableName: "users" });

    // 无取消请求：元数据落地后按既有行为执行第二次查询
    expect(mocks.executeTabSql).toHaveBeenCalledTimes(2);
  });
});
