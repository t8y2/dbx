import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMulti = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const getConnectionConfig = vi.fn();
const buildSortedQuerySql = vi.fn();

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability,
  buildSortedQuerySql,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  executeMulti,
  getColumns,
  listIndexes,
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({
    sqlToExecute: options.sql,
    pageSql: undefined,
    pageLimit: undefined,
    pageOffset: undefined,
    countSql: undefined,
    useAgentResultSession: false,
  })),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100 },
  }),
}));

function queryAnalysis(sql: string) {
  const hidden = sql.includes("__DBX_PK_0");
  return {
    editable: true,
    analysis: {
      schema: undefined,
      tableName: "users",
      selectStar: false,
      columns: [{ sourceName: "name", resultName: "name", expression: "name" }, ...(hidden ? [{ sourceName: "id", resultName: "__DBX_PK_0", expression: "`id`" }] : [])],
    },
  };
}

describe("queryStore hidden primary key editing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => queryAnalysis(sql));
    buildSortedQuerySql.mockImplementation(async (options) => ({ ok: true, sql: `${options.originalSql} ORDER BY ${options.column} ${options.direction.toUpperCase()}` }));
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "__DBX_PK_0"],
        rows: [["Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
  });

  it("executes and hides an omitted primary key while retaining its source mapping", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name, `id` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryAnalysis?.allowInsert).toBe(false);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps hidden primary keys and editability after database sorting", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users", {
      resultBaseSql: "SELECT name FROM users",
      querySort: {
        resultColumns: ["name"],
        columnIndex: 0,
        column: "name",
        direction: "asc",
      },
    });

    expect(buildSortedQuerySql).toHaveBeenCalledWith({
      originalSql: "SELECT name, `id` AS `__DBX_PK_0` FROM users",
      databaseType: "mysql",
      resultColumns: ["name", "__DBX_PK_0"],
      columnIndex: 0,
      column: "name",
      direction: "asc",
    });
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name, `id` AS `__DBX_PK_0` FROM users ORDER BY name ASC", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    expect(tab.resultSortedSql).toBe("SELECT name, `id` AS `__DBX_PK_0` FROM users ORDER BY name ASC");
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.queryAnalysis).toBeDefined();
  });

  it("preserves the original query behavior when the primary key is already returned", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        selectStar: false,
        columns: [
          { sourceName: "id", resultName: "id", expression: "id" },
          { sourceName: "name", resultName: "name", expression: "name" },
        ],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "name"],
        rows: [[7, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT id, name FROM users");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT id, name FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["id", "name"]));
    expect(tab.queryAnalysis?.allowInsert).toBeUndefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("loads unqualified Oracle metadata from the login schema instead of the service name", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "XEPDB1", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "NAME", data_type: "VARCHAR2", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: undefined,
          tableName: "DBX_HIDDEN_PK_EDIT_TEST",
          selectStar: false,
          columns: [{ sourceName: "NAME", resultName: "NAME", expression: "NAME" }, ...(hidden ? [{ sourceName: "ID", resultName: "__DBX_PK_0", expression: '"ID"' }] : [])],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["NAME", "__DBX_PK_0"],
        rows: [["Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "XEPDB1", "Query");

    await store.executeTabSql(tabId, "SELECT NAME FROM DBX_HIDDEN_PK_EDIT_TEST");

    expect(getColumns).toHaveBeenCalledWith("oracle-1", "XEPDB1", "", "DBX_HIDDEN_PK_EDIT_TEST", undefined);
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "XEPDB1", 'SELECT NAME, "ID" AS "__DBX_PK_0" FROM DBX_HIDDEN_PK_EDIT_TEST', undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["NAME", "ID"]));
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryAnalysis?.allowInsert).toBe(false);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("appends only the missing part of a composite primary key", async () => {
    getColumns.mockResolvedValue([
      { name: "tenant_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "item_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: undefined,
          tableName: "items",
          selectStar: false,
          columns: [{ sourceName: "tenant_id", resultName: "tenant_id", expression: "tenant_id" }, { sourceName: "name", resultName: "name", expression: "name" }, ...(hidden ? [{ sourceName: "item_id", resultName: "__DBX_PK_0", expression: "`item_id`" }] : [])],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["tenant_id", "name", "__DBX_PK_0"],
        rows: [[3, "Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT tenant_id, name FROM items");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT tenant_id, name, `item_id` AS `__DBX_PK_0` FROM items", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([2]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["tenant_id", "name", "item_id"]));
  });

  it("executes the original SQL when metadata loading fails", async () => {
    getColumns.mockRejectedValue(new Error("metadata unavailable"));
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
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("metadata-unavailable"));
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
  });

  it("does not hide a unique index when the table has no declared primary key", async () => {
    getColumns.mockResolvedValue([
      { name: "email", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([{ name: "uq_users_email", columns: ["email"], is_unique: true, is_primary: false }]);
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
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("primary-key-not-returned"));
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
  });

  it("hides returned internal keys but remains read-only when another hidden key is missing", async () => {
    getColumns.mockResolvedValue([
      { name: "tenant_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "item_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: undefined,
          tableName: "items",
          selectStar: false,
          columns: [
            { sourceName: "name", resultName: "name", expression: "name" },
            ...(hidden
              ? [
                  { sourceName: "tenant_id", resultName: "__DBX_PK_0", expression: "`tenant_id`" },
                  { sourceName: "item_id", resultName: "__DBX_PK_1", expression: "`item_id`" },
                ]
              : []),
          ],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "__DBX_PK_1"],
        rows: [["Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM items");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("primary-key-not-returned"));
    expect(tab.queryAnalysis).toBeUndefined();
  });
});
