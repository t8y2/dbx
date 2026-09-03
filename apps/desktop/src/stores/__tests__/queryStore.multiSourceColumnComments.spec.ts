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

const ordersColumns = [column("id", "订单ID", true), column("user_id", "下单用户"), column("amount", "订单金额")];
const usersColumns = [column("id", "用户ID", true), column("name", "用户名")];

/** SELECT a.id, a.user_id, b.id, b.name FROM orders a JOIN users b ON a.user_id = b.id */
const joinAnalysis = {
  editable: true,
  analysis: {
    schema: undefined,
    tableName: "orders",
    tableAlias: "a",
    selectStar: false,
    columns: [
      { sourceName: "id", sourceKey: "a", resultName: "id", expression: "a.id" },
      { sourceName: "user_id", sourceKey: "a", resultName: "user_id", expression: "a.user_id" },
      { sourceName: "id", sourceKey: "b", resultName: "id_1", expression: "b.id" },
      { sourceName: "name", sourceKey: "b", resultName: "name", expression: "b.name" },
    ],
    sources: [
      { key: "a", tableName: "orders", alias: "a" },
      { key: "b", tableName: "users", alias: "b" },
    ],
    multiSource: true,
    allowInsertDelete: false,
  },
};

describe("queryStore multi-source result column comments", () => {
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
    analyzeEditableQueryEditability.mockResolvedValue(joinAnalysis);
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: `${"SELECT *"} ORDER BY 1` });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `orders`");
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[0]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "user_id", "id_1", "name"],
        rows: [[1, 100, 7, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("stores per-ordinal comments and source identity for every JOIN source column", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT a.id, a.user_id, b.id, b.name FROM orders a JOIN users b ON a.user_id = b.id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    // Multi-source results stay non-editable: no single tableMeta.
    expect(tab.tableMeta).toBeUndefined();
    expect(tab.queryEditabilityReason).toBe("complex-source");
    expect(tab.querySourceColumns).toBeUndefined();

    // Comments are indexed by result ordinal, so the second `id` (users.id)
    // keeps its own comment instead of first-source-wins on the name.
    expect(tab.resultColumnComments).toEqual(["订单ID", "下单用户", "用户ID", "用户名"]);

    // The display mapping carries both source identity and physical table
    // identity per ordinal, so display-only features can share table settings.
    expect(tab.queryDisplaySourceColumns).toEqual([
      { sourceKey: "a", sourceColumn: "id", database: "app", schema: "app", tableName: "orders" },
      { sourceKey: "a", sourceColumn: "user_id", database: "app", schema: "app", tableName: "orders" },
      { sourceKey: "b", sourceColumn: "id", database: "app", schema: "app", tableName: "users" },
      { sourceKey: "b", sourceColumn: "name", database: "app", schema: "app", tableName: "users" },
    ]);
  });

  it("resolves a uniquely qualified unqualified alias back to its physical column", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        tableAlias: "a",
        selectStar: false,
        columns: [
          { sourceName: "id", sourceKey: "a", resultName: "id", expression: "a.id" },
          { sourceName: "name", sourceKey: undefined, resultName: "username", expression: "name" },
        ],
        sources: [
          { key: "a", tableName: "orders", alias: "a" },
          { key: "b", tableName: "users", alias: "b" },
        ],
        multiSource: true,
        allowInsertDelete: false,
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "username"],
        rows: [[1, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    // `name` exists only in users across the joined sources, so the unqualified
    // alias resolves back to users.name despite the binder never seeing a key.
    await store.executeTabSql(tabId, "SELECT a.id, name AS username FROM orders a JOIN users b ON a.user_id = b.id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual(["订单ID", "用户名"]);
    expect(tab.queryDisplaySourceColumns).toEqual([
      { sourceKey: "a", sourceColumn: "id", database: "app", schema: "app", tableName: "orders" },
      { sourceKey: "b", sourceColumn: "name", database: "app", schema: "app", tableName: "users" },
    ]);
  });

  it("returns no comment for an ambiguous unqualified column shared by several sources", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        tableAlias: "a",
        selectStar: false,
        columns: [{ sourceName: "id", sourceKey: undefined, resultName: "id", expression: "id" }],
        sources: [
          { key: "a", tableName: "orders", alias: "a" },
          { key: "b", tableName: "users", alias: "b" },
        ],
        multiSource: true,
        allowInsertDelete: false,
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    // Both orders and users expose `id`; the unqualified reference is
    // ambiguous, so the result column must not claim either table's comment.
    await store.executeTabSql(tabId, "SELECT id FROM orders a JOIN users b ON a.user_id = b.id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual([undefined]);
    expect(tab.queryDisplaySourceColumns).toEqual([undefined]);
  });

  it("resolves quoted mixed-case identifiers exactly, per the database's rules", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    const quotedOrders = [column("id", "订单ID", true), column("ID", "大写ID"), column("user_id", "下单用户")];
    const quotedUsers = [column("id", "用户ID", true), column("Name", "大写Name")];
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => (table === "orders" ? quotedOrders : quotedUsers));
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        tableAlias: "a",
        selectStar: false,
        columns: [
          { sourceName: "id", sourceNameQuoted: false, sourceKey: "a", resultName: "id", expression: "a.id" },
          { sourceName: "ID", sourceNameQuoted: true, sourceKey: "a", resultName: "ID", expression: 'a."ID"' },
          { sourceName: "Name", sourceNameQuoted: true, sourceKey: "b", resultName: "Name", expression: 'b."Name"' },
        ],
        sources: [
          { key: "a", tableName: "orders", alias: "a" },
          { key: "b", tableName: "users", alias: "b" },
        ],
        multiSource: true,
        allowInsertDelete: false,
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "ID", "Name"],
        rows: [[1, 9, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query");

    await store.executeTabSql(tabId, 'SELECT a.id, a."ID", b."Name" FROM orders a JOIN users b ON a.user_id = b.id');

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    // Quoted `"ID"` stays distinct from unquoted `id`; the global lower-casing
    // of the previous map would have collapsed them.
    expect(tab.resultColumnComments).toEqual(["订单ID", "大写ID", "大写Name"]);
    expect(tab.queryDisplaySourceColumns).toEqual([
      { sourceKey: "a", sourceColumn: "id", database: "app", schema: undefined, tableName: "orders" },
      { sourceKey: "a", sourceColumn: "ID", database: "app", schema: undefined, tableName: "orders" },
      { sourceKey: "b", sourceColumn: "Name", database: "app", schema: undefined, tableName: "users" },
    ]);
  });

  it("keeps duplicate result column names resolved in projection order", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        tableAlias: "a",
        selectStar: false,
        columns: [
          { sourceName: "id", sourceKey: "a", resultName: "id", expression: "a.id" },
          { sourceName: "id", sourceKey: "b", resultName: "id", expression: "b.id" },
        ],
        sources: [
          { key: "a", tableName: "orders", alias: "a" },
          { key: "b", tableName: "users", alias: "b" },
        ],
        multiSource: true,
        allowInsertDelete: false,
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "id_1"],
        rows: [[1, 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    // The driver renames the second `id` to `id_1`; ordinal mapping still
    // resolves column #1 to users.id instead of failing to match by name.
    await store.executeTabSql(tabId, "SELECT a.id, b.id FROM orders a JOIN users b ON a.user_id = b.id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual(["订单ID", "用户ID"]);
    expect(tab.queryDisplaySourceColumns).toEqual([
      { sourceKey: "a", sourceColumn: "id", database: "app", schema: "app", tableName: "orders" },
      { sourceKey: "b", sourceColumn: "id", database: "app", schema: "app", tableName: "users" },
    ]);
  });

  it("stores physical source identities for single-source result columns", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        selectStar: false,
        columns: [
          { sourceName: "id", sourceKey: "orders:0", resultName: "id", expression: "id" },
          { sourceName: "amount", sourceKey: "orders:0", resultName: "amount", expression: "amount" },
        ],
      },
    });
    getColumns.mockResolvedValue(ordersColumns);
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "amount"],
        rows: [[1, 9.99]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT id, amount FROM orders");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("orders"));
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.queryDisplaySourceColumns).toEqual([
      { sourceKey: "orders:0", sourceColumn: "id", database: "app", schema: "app", tableName: "orders" },
      { sourceKey: "orders:0", sourceColumn: "amount", database: "app", schema: "app", tableName: "orders" },
    ]);
    expect(tab.querySourceColumns).toEqual(["id", "amount"]);
  });

  it("stores PostgreSQL keyless SELECT-star comments by result ordinal without changing editability", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "public",
        tableName: "people",
        selectStar: true,
        columns: [],
      },
    });
    getColumns.mockResolvedValue([column("name", "姓名"), column("email", "邮箱")]);
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "email"],
        rows: [["Alice", "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM public.people");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual(["姓名", "邮箱"]);
    expect(tab.tableMeta?.primaryKeys).toEqual([]);
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("resolves unqualified PostgreSQL metadata through search_path when no schema is selected", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "people",
        selectStar: true,
        columns: [],
      },
    });
    getColumns.mockResolvedValue([column("name", "姓名"), column("email", "邮箱")]);
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "email"],
        rows: [["Alice", "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM people");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toEqual(["姓名", "邮箱"]));
    expect(getColumns).toHaveBeenCalledWith("pg-1", "app", "", "people", undefined);
    expect(listIndexes).toHaveBeenCalledWith("pg-1", "app", "", "people", undefined);
  });

  it("does not add explicit result comments to an adjacent keyed PostgreSQL query", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "public",
        tableName: "people",
        selectStar: true,
        columns: [],
      },
    });
    getColumns.mockResolvedValue([column("id", "编号", true), column("name", "姓名")]);
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "name"],
        rows: [[1, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM public.people");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.primaryKeys).toEqual(["id"]));
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps keyless ordinal metadata empty when PostgreSQL columns have no comments", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "public",
        tableName: "people",
        selectStar: true,
        columns: [],
      },
    });
    getColumns.mockResolvedValue([column("name", null), column("email", null)]);
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "email"],
        rows: [["Alice", "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM public.people");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual([undefined, undefined]);
  });

  it("keeps unsupported keyless row predicates read-only while surfacing comments", async () => {
    getConnectionConfig.mockReturnValue({ id: "trino-1", name: "Trino", db_type: "trino", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "public",
        tableName: "people",
        selectStar: true,
        columns: [],
      },
    });
    getColumns.mockResolvedValue([column("name", "display name")]);
    executeMulti.mockResolvedValue([
      {
        columns: ["name"],
        rows: [["Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("trino-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM public.people");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(tab.resultColumnComments).toEqual(["display name"]);
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.querySourceColumns).toBeUndefined();
    expect(tab.queryEditabilityReason).toBe("no-primary-key");
  });
});
