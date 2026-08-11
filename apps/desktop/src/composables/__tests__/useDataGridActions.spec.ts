import { computed } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { clearTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import type { QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(),
  buildSortedQuerySql: vi.fn(),
  executeTabSql: vi.fn(),
  getConfig: vi.fn(),
  setExecuting: vi.fn(),
  updateSql: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  ensureConnected: vi.fn(),
  tableOpenPageSize: 100,
  infiniteScroll: true,
  queryResultMaxRowsEnabled: true,
  queryResultMaxRows: 10_000,
  tabs: [] as QueryTab[],
  setTableMeta: vi.fn(),
  clearInvalidDataTabSort: vi.fn(),
  activeResultExecutionTarget: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  buildSortedQuerySql: mocks.buildSortedQuerySql,
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
}));

vi.mock("@/lib/table/tableSelectSql", () => ({
  buildTableSelectSql: mocks.buildTableSelectSql,
  quoteTableDataIdentifier: (_databaseType: string, name: string) => `"${name}"`,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    executeTabSql: mocks.executeTabSql,
    activeResultExecutionTarget: mocks.activeResultExecutionTarget,
    setExecuting: mocks.setExecuting,
    updateSql: mocks.updateSql,
    tabs: mocks.tabs,
    clearInvalidDataTabSort: mocks.clearInvalidDataTabSort.mockImplementation((id: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (!tab?.tableMeta?.columns.length) return false;
      const simpleOrderColumn = tab.orderByInput?.match(/^"([^"]+)"\s+(?:ASC|DESC)$/i)?.[1];
      const staleSort = !!tab.resultSortColumn && !tab.tableMeta.columns.some((column) => column.name === tab.resultSortColumn);
      const staleOrder = !!simpleOrderColumn && !tab.tableMeta.columns.some((column) => column.name === simpleOrderColumn);
      if (!staleSort && !staleOrder) return false;
      if (staleSort) {
        tab.resultSortColumn = undefined;
        tab.resultSortColumnIndex = undefined;
        tab.resultSortDirection = undefined;
        tab.resultSortMode = undefined;
        tab.resultSortedSql = undefined;
      }
      if (staleOrder) tab.orderByInput = undefined;
      return true;
    }),
    setTableMeta: mocks.setTableMeta.mockImplementation((id: string, meta: NonNullable<QueryTab["tableMeta"]>) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.tableMeta = meta;
        tab.tableMetaUpdatedAt = Date.now();
        // 与真实 store 一致：仅真实元数据（columns 非空）落地才结束行标识等待
        if (meta.columns.length > 0) tab.tableMetaPending = false;
      }
    }),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      tableOpenPageSize: mocks.tableOpenPageSize,
      infiniteScroll: mocks.infiniteScroll,
      queryResultMaxRowsEnabled: mocks.queryResultMaxRowsEnabled,
      queryResultMaxRows: mocks.queryResultMaxRows,
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function tableDataTab(patch: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    connectionId: "postgres-1",
    database: "app",
    title: "users",
    sql: "SELECT * FROM public.users",
    result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
    mode: "data",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    tableMetaUpdatedAt: Date.now(),
    tableMeta: {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    },
    ...patch,
  } as QueryTab;
}

describe("useDataGridActions", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    vi.clearAllMocks();
    mocks.tabs.length = 0;
    mocks.tableOpenPageSize = 100;
    mocks.infiniteScroll = true;
    mocks.queryResultMaxRowsEnabled = true;
    mocks.queryResultMaxRows = 10_000;
    mocks.getConfig.mockReturnValue({ id: "postgres-1", db_type: "postgres" });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM public.users LIMIT 100 OFFSET 0");
    mocks.buildSortedQuerySql.mockResolvedValue({ ok: true, sql: "SELECT sorted" });
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.activeResultExecutionTarget.mockReturnValue(undefined);
    mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    mocks.listIndexes.mockResolvedValue([]);
  });

  it("uses the configured table-data default when toolbar reload has no saved pagination", async () => {
    mocks.tableOpenPageSize = 250;
    mocks.buildTableSelectSql.mockResolvedValueOnce("SELECT * FROM public.users LIMIT 250 OFFSET 0");
    const tab = tableDataTab();
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 250,
        offset: 0,
      }),
    );
    expect(mocks.executeTabSql).toHaveBeenCalledWith("tab-1", "SELECT * FROM public.users LIMIT 250 OFFSET 0", expect.objectContaining({ pagination: { limit: 250, offset: 0 } }));
    expect(mocks.executeTabSql.mock.calls[0]?.[2]).not.toHaveProperty("preserveTotalRowCountDuringExecution");
  });

  it("preserves the toolbar page segment and offset for table-data refresh", async () => {
    const tab = tableDataTab({
      resultPageLimit: 25,
      resultPageOffset: 50,
    });
    mocks.buildTableSelectSql.mockResolvedValueOnce("SELECT * FROM public.users LIMIT 25 OFFSET 50");
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", 25, 50, "refresh");

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, offset: 50 }));
    expect(mocks.executeTabSql).toHaveBeenCalledWith("tab-1", "SELECT * FROM public.users LIMIT 25 OFFSET 50", expect.objectContaining({ pagination: { limit: 25, offset: 50 } }));
    expect(mocks.executeTabSql.mock.calls[0]?.[2]).not.toHaveProperty("preserveTotalRowCountDuringExecution");
  });

  it("keeps infinite-scroll appends for ordinary table-data pages", async () => {
    const tab = tableDataTab({
      result: {
        columns: ["id"],
        rows: Array.from({ length: 100 }, (_, index) => [index + 1]),
        affected_rows: 0,
        execution_time_ms: 1,
      },
    });
    mocks.buildTableSelectSql.mockResolvedValueOnce("SELECT * FROM public.users LIMIT 100 OFFSET 100");
    const actions = useDataGridActions(computed(() => tab));

    await actions.onPaginate(100, 100);

    expect(mocks.executeTabSql).toHaveBeenCalledWith("tab-1", "SELECT * FROM public.users LIMIT 100 OFFSET 100", expect.objectContaining({ appendResult: { maxRows: 10_000 } }));
  });

  it("ignores a stale structured order when its column was renamed", async () => {
    const tab = tableDataTab({
      resultSortColumn: "old_name",
      resultSortColumnIndex: 1,
      resultSortDirection: "asc",
      resultSortMode: "database",
      orderByInput: '"old_name" ASC',
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        primaryKeys: ["id"],
      },
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", '"old_name" ASC', undefined, undefined, "refresh");

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: undefined }));
    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.orderByInput).toBeUndefined();
  });

  it("ignores a stale order emitted by a mounted grid after the stored sort was cleared", async () => {
    const tab = tableDataTab({
      orderByInput: undefined,
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        primaryKeys: ["id"],
      },
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", '"old_name" ASC', undefined, undefined, "refresh");

    expect(mocks.clearInvalidDataTabSort).toHaveReturnedWith(false);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: undefined }));
    expect(tab.orderByInput).toBeUndefined();
  });

  it("keeps a manual order when only residual structured sort state is stale", async () => {
    const tab = tableDataTab({
      resultSortColumn: "old_name",
      resultSortColumnIndex: 1,
      resultSortDirection: "asc",
      resultSortMode: "database",
      orderByInput: "LOWER(new_name) ASC",
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        primaryKeys: ["id"],
      },
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "LOWER(new_name) ASC", undefined, undefined, "refresh");

    expect(mocks.clearInvalidDataTabSort).toHaveReturnedWith(true);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: "LOWER(new_name) ASC" }));
    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.orderByInput).toBe("LOWER(new_name) ASC");
  });

  it("keeps SQL result toolbar reload free of table pagination defaults", async () => {
    const tab = {
      id: "tab-1",
      connectionId: "postgres-1",
      database: "app",
      title: "Query",
      sql: "SELECT 1",
      result: { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      mode: "query",
      isDirty: false,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
    } as QueryTab;
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    expect(mocks.buildTableSelectSql).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).toHaveBeenCalledWith(
      "tab-1",
      "SELECT 1",
      expect.objectContaining({
        resultBaseSql: "SELECT 1",
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
      }),
    );
  });

  it("marks row identity pending and refreshes metadata when real columns are missing, despite fallback result columns", async () => {
    // 恢复的占位身份：真实 tableMeta.columns 为空，但存在（失败）结果列。
    // tableMetaForDataTab 会用结果列合成 columns，不得据此跳过刷新
    const tab = tableDataTab({
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
      tableMetaUpdatedAt: Date.now(),
      result: { columns: ["Error"], rows: [["boom"]], affected_rows: 0, execution_time_ms: 1 },
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    // 合成的 ["Error"] 结果列不得进入 SQL 投影：真实列缺失时省略 columns（SELECT *）
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ columns: undefined }));
    await vi.waitFor(() => {
      expect(mocks.getColumns).toHaveBeenCalled();
      expect(mocks.setTableMeta).toHaveBeenCalledWith("tab-1", expect.objectContaining({ primaryKeys: ["id"] }));
      expect(tab.tableMetaPending).toBe(false);
    });
  });

  it("reuses an in-flight metadata refresh when a later reload can apply the result", async () => {
    const tab = tableDataTab({
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
      tableMetaUpdatedAt: Date.now(),
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    // 第一轮：stale-tab 早退（tabs 里找不到匹配项时 refreshDataTabTableMeta 直接返回）
    mocks.tabs.length = 0;
    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalledTimes(1));
    expect(mocks.setTableMeta).not.toHaveBeenCalled();
    expect(tab.tableMetaPending).toBe(true);

    // 第二轮：真实 columns 仍为空，新的消费者加入同一在途请求；共享缓存应
    // 去重后端调用，但本轮仍要在目标恢复后落地结果
    mocks.tabs.push(tab);
    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");
    await vi.waitFor(() => {
      expect(mocks.getColumns).toHaveBeenCalledTimes(1);
      expect(mocks.setTableMeta).toHaveBeenCalledWith("tab-1", expect.objectContaining({ primaryKeys: ["id"] }));
    });
  });

  it("defers the Dameng metadata refresh until after the reload query", async () => {
    mocks.getConfig.mockReturnValue({ id: "dameng-1", db_type: "dameng" });
    const callOrder: string[] = [];
    const tab = tableDataTab({
      connectionId: "dameng-1",
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
      tableMetaUpdatedAt: Date.now(),
    });
    mocks.executeTabSql.mockImplementationOnce(async () => {
      callOrder.push("query");
      // 查询执行期间：元数据尚未启动，行标识等待保持
      expect(tab.tableMetaPending).toBe(true);
    });
    mocks.getColumns.mockImplementationOnce(async () => {
      callOrder.push("metadata");
      return [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }];
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    // Dameng 元数据必须排在数据查询之后（串行约束，同 useSidebarDataOpenRuntime）；
    // 真实元数据落地后结束行标识等待
    await vi.waitFor(() => {
      expect(callOrder).toEqual(["query", "metadata"]);
      expect(tab.tableMetaPending).toBe(false);
      expect(tab.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });

  it("starts the deferred Dameng metadata refresh even when the reload query rejects", async () => {
    mocks.getConfig.mockReturnValue({ id: "dameng-1", db_type: "dameng" });
    mocks.executeTabSql.mockRejectedValueOnce(new Error("query failed"));
    const tab = tableDataTab({
      connectionId: "dameng-1",
      tableMeta: { schema: "public", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] },
      tableMetaUpdatedAt: Date.now(),
    });
    mocks.tabs.push(tab);
    const actions = useDataGridActions(computed(() => tab));

    // 查询 reject 仍会重新抛出，但元数据刷新必须已启动，标签页可恢复
    await expect(actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh")).rejects.toThrow("query failed");
    await vi.waitFor(() => {
      expect(mocks.getColumns).toHaveBeenCalled();
      expect(tab.tableMetaPending).toBe(false);
    });
  });

  it("excludes hidden primary keys and remaps the selected column for database sorting", async () => {
    const tab = {
      id: "tab-1",
      connectionId: "postgres-1",
      database: "app",
      title: "Query",
      sql: "SELECT name, email FROM users",
      resultBaseSql: "SELECT name, email FROM users",
      result: {
        columns: ["name", "__DBX_PK_0", "email"],
        hidden_column_indexes: [1],
        rows: [["Alice", 7, "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
      mode: "query",
      isDirty: false,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
    } as QueryTab;
    const actions = useDataGridActions(computed(() => tab));

    await actions.onSort("email", 2, "asc");

    expect(mocks.executeTabSql).toHaveBeenCalledWith(
      "tab-1",
      "SELECT name, email FROM users",
      expect.objectContaining({
        resultBaseSql: "SELECT name, email FROM users",
        querySort: {
          resultColumns: ["name", "email"],
          columnIndex: 1,
          column: "email",
          direction: "asc",
        },
      }),
    );
  });

  it("uses the active multi-database result target for pagination", async () => {
    const tab = {
      id: "tab-1",
      connectionId: "source-1",
      database: "source_db",
      title: "Query",
      sql: "SELECT * FROM users",
      resultBaseSql: "SELECT * FROM users",
      resultPageLimit: 100,
      resultPageOffset: 0,
      result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      mode: "query",
      isDirty: false,
      isExecuting: false,
      isExplaining: false,
    } as QueryTab;
    const target = { connectionId: "target-2", database: "reporting", schema: "audit" };
    mocks.activeResultExecutionTarget.mockReturnValue(target);
    mocks.getConfig.mockImplementation((id: string) => ({ id, db_type: "postgres" }));
    const actions = useDataGridActions(computed(() => tab));

    await actions.onPaginate(100, 100);

    expect(mocks.executeTabSql).toHaveBeenCalledWith(
      "tab-1",
      "SELECT * FROM users",
      expect.objectContaining({
        executionTarget: target,
        targetContext: { scope: "database", database: "reporting", schema: "audit" },
        pagination: { offset: 100, limit: 100, sessionId: undefined },
      }),
    );
  });
});
