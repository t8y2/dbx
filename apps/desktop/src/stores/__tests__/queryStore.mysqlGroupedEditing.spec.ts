import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  useSettingsStore: () => ({ editorSettings }),
}));

function column(name: string, isPrimaryKey = false, comment: string | null = null, extra: string | null = null) {
  return { name, data_type: "varchar", is_nullable: !isPrimaryKey, column_default: null, is_primary_key: isPrimaryKey, extra, comment };
}

const usersColumns = [column("id", true, "user id"), column("department", false, "department"), column("display_label", false, "display label", "VIRTUAL GENERATED"), column("stored_label", false, "stored label", "STORED GENERATED")];
const ordersColumns = [column("id", true, "order id"), column("user_id"), column("amount")];
const membershipColumns = [column("tenant_id", true), column("user_id", true), column("label")];

function columnsFor(table: string) {
  if (table === "orders") return ordersColumns;
  if (table === "memberships") return membershipColumns;
  return usersColumns;
}

describe("queryStore MySQL grouped-result editing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => columnsFor(table));
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: "SELECT 1 ORDER BY 1" });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*)");
    executeQuery.mockResolvedValue({ columns: ["row_count"], rows: [[0]], affected_rows: 0, execution_time_ms: 1 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
  });

  async function executeGrouped(sql: string, columns: string[]) {
    executeMulti.mockResolvedValue([{ columns, rows: [columns.map(() => 1)], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId, sql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason !== undefined || tab.queryAnalysis !== undefined).toBe(true));
    return tab;
  }

  it("enables only direct columns from the single source with a complete primary key", async () => {
    const tab = await executeGrouped("SELECT u.id AS user_id, u.department AS dept, COUNT(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["user_id", "dept", "order_count"]);

    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.queryAnalysis).toMatchObject({ tableName: "users", editableSourceKey: "u:0", allowInsert: false, allowInsertDelete: false, multiSource: true });
    expect(tab.querySourceColumns).toEqual(["id", "department", undefined]);
    expect(tab.tableMeta).toMatchObject({ tableName: "users", primaryKeys: ["id"] });
    expect(tab.resultColumnComments).toEqual(["user id", "department", undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "u:0", sourceColumn: "id" }, { sourceKey: "u:0", sourceColumn: "department" }, undefined]);
    expect(listIndexes).not.toHaveBeenCalled();
  });

  it("identifies the FROM root independently of metadata completion order", async () => {
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => {
      if (table === "users") await new Promise((resolve) => setTimeout(resolve, 10));
      return columnsFor(table);
    });

    const tab = await executeGrouped("SELECT u.id, u.department, COUNT(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["id", "department", "order_count"]);

    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.queryAnalysis).toMatchObject({ tableName: "users", editableSourceKey: "u:0" });
    expect(tab.querySourceColumns).toEqual(["id", "department", undefined]);
  });

  it("keeps direct columns from non-target sources and aggregate expressions read-only", async () => {
    const tab = await executeGrouped("SELECT u.id AS user_id, u.department AS dept, o.user_id AS joined_user_id, COUNT(*) AS row_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["user_id", "dept", "joined_user_id", "row_count"]);

    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.querySourceColumns).toEqual(["id", "department", undefined, undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "u:0", sourceColumn: "id" }, { sourceKey: "u:0", sourceColumn: "department" }, { sourceKey: "o:1", sourceColumn: "user_id" }, undefined]);
  });

  it("keeps a non-root source read-only even when its complete primary key is grouped", async () => {
    const tab = await executeGrouped("SELECT o.id AS order_key, o.department AS dept, e.user_id AS joined_user_id, COUNT(e.id) AS event_count FROM orders e LEFT JOIN users o ON o.id = e.user_id GROUP BY o.id", ["order_key", "dept", "joined_user_id", "event_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
  });

  it("keeps the result read-only when a composite primary key is incomplete", async () => {
    const tab = await executeGrouped("SELECT m.tenant_id, m.label, COUNT(*) AS row_count FROM memberships m GROUP BY m.tenant_id, m.label", ["tenant_id", "label", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
  });

  it("keeps the result read-only when two source tables are independently writable", async () => {
    const tab = await executeGrouped("SELECT u.id AS user_id, u.department, o.id AS order_id, o.amount, COUNT(*) AS row_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.department, o.id, o.amount", ["user_id", "department", "order_id", "amount", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
  });

  it("keeps the result read-only when GROUP BY contains an additional join dimension", async () => {
    const tab = await executeGrouped("SELECT u.id, u.department, o.user_id, COUNT(*) AS row_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id, o.user_id", ["id", "department", "user_id", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });

  it("keeps the result read-only when GROUP BY contains an additional target column", async () => {
    const tab = await executeGrouped("SELECT u.id, u.department, COUNT(*) AS row_count FROM users u GROUP BY u.id, u.department", ["id", "department", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });

  it("does not infer target primary-key grouping through a joined source column", async () => {
    const tab = await executeGrouped("SELECT u.id, u.department, COUNT(*) AS row_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY o.user_id", ["id", "department", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });

  it("keeps DISTINCT, HAVING, windowed, and right-joined grouped results read-only", async () => {
    const distinct = await executeGrouped("SELECT DISTINCT u.id, u.department, COUNT(*) AS row_count FROM users u GROUP BY u.id", ["id", "department", "row_count"]);
    const having = await executeGrouped("SELECT u.id, u.department, COUNT(*) AS row_count FROM users u GROUP BY u.id HAVING COUNT(*) > 1", ["id", "department", "row_count"]);
    const windowed = await executeGrouped("SELECT u.id, u.department, ROW_NUMBER() OVER (ORDER BY u.id) AS row_number, COUNT(*) AS row_count FROM users u GROUP BY u.id", ["id", "department", "row_number", "row_count"]);
    const rightJoined = await executeGrouped("SELECT u.id, u.department, COUNT(*) AS row_count FROM users u RIGHT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["id", "department", "row_count"]);

    expect(distinct.queryEditabilityReason).toBe("aggregation");
    expect(distinct.queryAnalysis).toBeUndefined();
    expect(having.queryEditabilityReason).toBe("aggregation");
    expect(having.queryAnalysis).toBeUndefined();
    expect(windowed.queryEditabilityReason).toBe("aggregation");
    expect(windowed.queryAnalysis).toBeUndefined();
    expect(rightJoined.queryEditabilityReason).toBe("aggregation");
    expect(rightJoined.queryAnalysis).toBeUndefined();
  });

  it("keeps generated and expression columns read-only without blocking ordinary target columns", async () => {
    const tab = await executeGrouped("SELECT u.id, u.department, u.display_label, u.stored_label, UPPER(u.department) AS upper_department, COUNT(*) AS row_count FROM users u GROUP BY u.id", ["id", "department", "display_label", "stored_label", "upper_department", "row_count"]);

    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.querySourceColumns).toEqual(["id", "department", undefined, undefined, undefined, undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([{ sourceKey: "u:0", sourceColumn: "id" }, { sourceKey: "u:0", sourceColumn: "department" }, { sourceKey: "u:0", sourceColumn: "display_label" }, { sourceKey: "u:0", sourceColumn: "stored_label" }, undefined, undefined]);
  });

  it("accepts a complete composite primary key only when it is the exact grouping key", async () => {
    const tab = await executeGrouped("SELECT m.tenant_id, m.user_id, m.label, COUNT(*) AS row_count FROM memberships m GROUP BY m.tenant_id, m.user_id", ["tenant_id", "user_id", "label", "row_count"]);

    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.querySourceColumns).toEqual(["tenant_id", "user_id", "label", undefined]);
    expect(tab.tableMeta).toMatchObject({ tableName: "memberships", primaryKeys: ["tenant_id", "user_id"] });
  });

  it("requires at least one non-primary direct column from the target", async () => {
    const tab = await executeGrouped("SELECT u.id, COUNT(*) AS row_count FROM users u GROUP BY u.id", ["id", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });

  it("does not enable grouped editing for non-MySQL connections", async () => {
    getConnectionConfig.mockReturnValue({ id: "postgres-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    const tab = await executeGrouped("SELECT u.id AS user_id, u.department AS dept, COUNT(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["user_id", "dept", "order_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });

  it("does not enable grouped editing for explicit MySQL-compatible driver profiles", async () => {
    getConnectionConfig.mockReturnValue({ id: "mariadb-1", name: "MariaDB", db_type: "mysql", driver_profile: "mariadb", database: "app", query_timeout_secs: 30 });
    const tab = await executeGrouped("SELECT u.id AS user_id, u.department AS dept, COUNT(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id", ["user_id", "dept", "order_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
  });

  it("does not enable grouped editing for an object known to be a view", async () => {
    lookupLocalCompletionTables.mockReturnValue([{ name: "users", type: "VIEW" }]);
    const tab = await executeGrouped("SELECT u.id, u.department, COUNT(*) AS row_count FROM users u GROUP BY u.id", ["id", "department", "row_count"]);

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
  });
});
