import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const getConnectionConfig = vi.fn();
const lookupLocalCompletionTables = vi.fn();
const buildSortedQuerySql = vi.fn();
const buildDataGridCountSql = vi.fn();
const prepareQueryPaginationExecutionPlan = vi.fn(async (options) => ({
  sqlToExecute: options.sql,
  pageSql: undefined,
  pageLimit: undefined,
  pageOffset: undefined,
  countSql: undefined,
  useAgentResultSession: false,
}));
const editorSettings = {
  pageSize: 100,
  autoCalculateTotalRows: false,
};

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability,
  buildDataGridCountSql,
  buildSortedQuerySql,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  executeMulti,
  executeQuery,
  getColumns,
  listIndexes,
  listObjects,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings,
  }),
}));

function column(name: string, comment: string | null, isPrimaryKey = false) {
  return { name, data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: isPrimaryKey, extra: null, comment };
}

const usersColumns = [column("id", "用户ID", true), column("department", "所属部门"), column("status", "用户状态")];
const ordersColumns = [column("id", "订单ID", true), column("user_id", "下单用户"), column("amount", "订单金额"), column("created_at", "创建时间")];

describe("queryStore grouped-result column comments", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => (table === "orders" ? ordersColumns : usersColumns));
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: `${"SELECT *"} ORDER BY 1` });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `users`");
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[0]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("shows physical column comments for grouped results while staying read-only (T1)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "total"],
        rows: [["sales", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    // Grouped results stay read-only: no editable analysis, no tableMeta.
    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();

    // Only the directly projected physical column carries its comment; the
    // aggregate expression resolves to nothing and must not guess.
    expect(tab.resultColumnComments).toEqual(["所属部门", undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "users:0", sourceColumn: "department" }, undefined]);
  });

  it("resolves aliased grouped columns back to their physical column (T2)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["dept", "total"],
        rows: [["sales", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT department AS dept, COUNT(*) AS total FROM users GROUP BY department");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.resultColumnComments).toEqual(["所属部门", undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "users:0", sourceColumn: "department" }, undefined]);
  });

  it("keeps comments for HAVING queries (T3)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "total"],
        rows: [["sales", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department HAVING COUNT(*) > 1");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.resultColumnComments).toEqual(["所属部门", undefined]);
  });

  it("resolves qualified grouped columns in a JOIN without leaking other sources (T4)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "order_count"],
        rows: [["sales", 3]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT u.department, COUNT(o.id) AS order_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.department");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.resultColumnComments).toEqual(["所属部门", undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "u:0", sourceColumn: "department" }, undefined]);
  });

  it("maps multiple grouped physical columns (T5)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "status", "count"],
        rows: [["sales", "active", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT department, status, COUNT(*) AS count FROM users GROUP BY department, status");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual(["所属部门", "用户状态", undefined]);
  });

  it("does not claim a comment for computed/aggregate expressions (T6/T7)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    executeMulti.mockResolvedValue([
      {
        columns: ["day", "total_amount"],
        rows: [["2026-01-01", 100]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT DATE(created_at) AS day, SUM(amount) AS total_amount FROM orders GROUP BY user_id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    // `day` is DATE(created_at) and `total_amount` is SUM(amount): neither may
    // inherit the operand column's comment.
    expect(tab.resultColumnComments).toEqual([undefined, undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([undefined, undefined]);
  });

  it("keeps ordinary editable queries free of the new display fields (T10)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        tableAlias: undefined,
        selectStar: false,
        columns: [
          { sourceName: "id", sourceKey: "users:0", resultName: "id", expression: "id" },
          { sourceName: "department", sourceKey: "users:0", resultName: "department", expression: "department" },
        ],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "department"],
        rows: [[1, "sales"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT id, department FROM users");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("users"));
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.queryDisplaySourceColumns).toBeUndefined();
    expect(tab.querySourceColumns).toEqual(["id", "department"]);
  });

  it("falls back gracefully when metadata loading fails (best-effort)", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
    getColumns.mockRejectedValue(new Error("metadata unavailable"));
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "total"],
        rows: [["sales", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");

    // The result stays queryEditabilityReason=aggregation; enrichment failure
    // must never fail the query nor claim comments.
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("aggregation"));
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.queryDisplaySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
    expect(tab.result?.rows.length).toBe(1);
  });
});
