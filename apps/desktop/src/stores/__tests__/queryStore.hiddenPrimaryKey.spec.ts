import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const getConnectionConfig = vi.fn();
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
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings,
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
    listObjects.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => queryAnalysis(sql));
    buildSortedQuerySql.mockImplementation(async (options) => ({ ok: true, sql: `${options.originalSql} ORDER BY ${options.column} ${options.direction.toUpperCase()}` }));
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `users`");
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    editorSettings.pageSize = 100;
    editorSettings.autoCalculateTotalRows = false;
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[0]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
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

  it("loads metadata from the connection default database when the query tab database is empty", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(getColumns).toHaveBeenCalledWith("mysql-1", "app", "app", "users", undefined);
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "", "SELECT name, `id` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.tableMeta?.database).toBe("app");
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("uses the connection default database for SQL library tabs without a saved database", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.openSavedSql({
      id: "saved-1",
      connectionId: "mysql-1",
      name: "users.sql",
      database: "",
      sql: "SELECT name FROM users",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(getColumns).toHaveBeenCalledWith("mysql-1", "app", "app", "users", undefined);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("preserves JDBC catalog metadata lookup when the tab uses the connection default database", async () => {
    getConnectionConfig.mockReturnValue({ id: "jdbc-1", name: "JDBC MySQL", db_type: "jdbc", connection_string: "jdbc:mysql://localhost:3306/app", database: "app", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-1", "", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(getColumns).toHaveBeenCalledWith("jdbc-1", "app", "", "users", undefined);
    expect(executeMulti).toHaveBeenCalledWith("jdbc-1", "", "SELECT name, `id` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps an explicitly selected database instead of falling back to the connection default", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "analytics", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(getColumns).toHaveBeenCalledWith("mysql-1", "analytics", "analytics", "users", undefined);
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "analytics", "SELECT name, `id` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
  });

  it("loads metadata from a MySQL cross-database qualified source", async () => {
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: "reporting",
          tableName: "users",
          selectStar: false,
          columns: [{ sourceName: "name", resultName: "name", expression: "name" }, ...(hidden ? [{ sourceName: "id", resultName: "__DBX_PK_0", expression: "`id`" }] : [])],
        },
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM reporting.users");

    expect(getColumns).toHaveBeenCalledWith("mysql-1", "app", "reporting", "users", undefined);
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name, `id` AS `__DBX_PK_0` FROM reporting.users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.tableMeta?.database).toBe("app");
    expect(tab.tableMeta?.schema).toBe("reporting");
  });

  it("uses a hidden Oracle ROWID to keep keyless base-table query results editable", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PLATFORM", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listObjects.mockResolvedValue([{ name: "TT_PLATFORM_CARS", object_type: "TABLE", schema: "SH_SMCVDMS_OVERSEAS_DRSSITB" }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: "SH_SMCVDMS_OVERSEAS_DRSSITB",
          tableName: "TT_PLATFORM_CARS",
          tableAlias: "t",
          selectStar: !hidden,
          columns: hidden
            ? [
                { star: true, sourceQualifier: "t", sourceKey: "t:0", resultName: "*", expression: "t.*" },
                { resultName: "__DBX_PK_0", expression: "ROWIDTOCHAR(ROWID)" },
              ]
            : [],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "PLATFORM", "__DBX_PK_0"],
        rows: [[72, "轻卡", "AAAPr9AAEAAAACXAAA"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.executeTabSql(tabId, "SELECT t.* FROM SH_SMCVDMS_OVERSEAS_DRSSITB.TT_PLATFORM_CARS t WHERE t.PLATFORM = '轻卡'");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT t.*, ROWIDTOCHAR(ROWID) AS \"__DBX_PK_0\" FROM SH_SMCVDMS_OVERSEAS_DRSSITB.TT_PLATFORM_CARS t WHERE t.PLATFORM = '轻卡'", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([2]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["ID", "PLATFORM", "__DBX_ROWID"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryAnalysis?.allowInsert).toBe(false);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("does not check Oracle ROWID eligibility when query metadata returns no columns", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "aa",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["Error"],
        rows: [["ORA-00942: table or view does not exist"]],
        affected_rows: 0,
        execution_time_ms: 1,
        execution_error: true,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM aa");

    expect(getColumns).toHaveBeenCalledWith("oracle-1", "ORCL", "", "AA", undefined);
    expect(listIndexes).not.toHaveBeenCalled();
    expect(listObjects).not.toHaveBeenCalled();
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM aa", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
  });

  it("keeps a keyless Oracle query editable when its WHERE clause reads another table", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "CUSTOMER_NO", data_type: "NUMBER", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listObjects.mockResolvedValue([{ name: "PLATFORM_CARS", object_type: "TABLE", schema: "APP" }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: "APP",
          tableName: "PLATFORM_CARS",
          tableAlias: "t",
          selectStar: !hidden,
          columns: hidden
            ? [
                { star: true, sourceQualifier: "t", sourceKey: "t:0", resultName: "*", expression: "t.*" },
                { resultName: "__DBX_PK_0", expression: "ROWIDTOCHAR(ROWID)" },
              ]
            : [],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "CUSTOMER_NO", "__DBX_PK_0"],
        rows: [[72, 2100196, "AAAPr9AAEAAAACXAAA"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const sql = "SELECT t.* FROM APP.PLATFORM_CARS t WHERE t.CUSTOMER_NO IN (SELECT c.CUSTOMER_NO FROM APP.CUSTOMERS c WHERE c.ENABLED = 1)";
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.executeTabSql(tabId, sql);

    expect(executeMulti).toHaveBeenCalledWith(
      "oracle-1",
      "ORCL",
      'SELECT t.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.PLATFORM_CARS t WHERE t.CUSTOMER_NO IN (SELECT c.CUSTOMER_NO FROM APP.CUSTOMERS c WHERE c.ENABLED = 1)',
      undefined,
      expect.any(String),
      expect.objectContaining({ timeoutSecs: 30 }),
    );
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([2]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["ID", "CUSTOMER_NO", "__DBX_ROWID"]));
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryAnalysis?.allowInsertDelete).not.toBe(false);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("does not inject Oracle ROWID into keyless view queries", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PLATFORM", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([{ name: "PLATFORM_VIEW", object_type: "VIEW", schema: "APP" }]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "PLATFORM_VIEW",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "PLATFORM"],
        rows: [[72, "轻卡"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.tableMeta = { schema: "APP", tableName: "PLATFORM_VIEW", tableType: "VIEW", columns: [], primaryKeys: [] };

    await store.executeTabSql(tabId, "SELECT * FROM APP.PLATFORM_VIEW");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM APP.PLATFORM_VIEW", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
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

  it("clears result sorting when the editor SQL is executed again", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.resultSortColumn = "name";
    tab.resultSortColumnIndex = 0;
    tab.resultSortDirection = "desc";
    tab.resultSortMode = "database";
    tab.resultSortedSql = "SELECT name FROM users ORDER BY name DESC";

    await store.executeCurrentSql("SELECT name FROM users");

    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortColumnIndex).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.resultSortMode).toBeUndefined();
    expect(tab.resultSortedSql).toBeUndefined();
    expect(executeMulti).toHaveBeenLastCalledWith("mysql-1", "app", "SELECT name, `id` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
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

  it("records the returned row count when a page is known to be incomplete without count sql", async () => {
    prepareQueryPaginationExecutionPlan.mockResolvedValue({
      sqlToExecute: "SELECT name FROM users LIMIT 100 OFFSET 0",
      pageSql: "SELECT name FROM users LIMIT 100 OFFSET 0",
      pageLimit: 100,
      pageOffset: 0,
      countSql: undefined,
      useAgentResultSession: false,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["name"],
        rows: Array.from({ length: 42 }, (_, index) => [`user-${index}`]),
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultTotalRowCount).toBe(42);
    expect(tab.resultTotalRowCountLoading).toBe(false);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("does not treat an empty later page as the total row count", async () => {
    prepareQueryPaginationExecutionPlan.mockResolvedValue({
      sqlToExecute: "SELECT name FROM users LIMIT 100 OFFSET 200",
      pageSql: "SELECT name FROM users LIMIT 100 OFFSET 200",
      pageLimit: 100,
      pageOffset: 200,
      countSql: undefined,
      useAgentResultSession: false,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["name"],
        rows: [],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultTotalRowCount).toBeUndefined();
    expect(tab.resultTotalRowCountLoading).toBe(false);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("automatically counts table data totals when the setting is enabled", async () => {
    editorSettings.autoCalculateTotalRows = true;
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "name"],
        rows: Array.from({ length: 100 }, (_, index) => [index + 1, `user-${index + 1}`]),
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[123]],
      affected_rows: 0,
      execution_time_ms: 1,
    });

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      columns: [
        { name: "id", data_type: "int", is_nullable: false, is_primary_key: true, column_default: null, extra: null },
        { name: "name", data_type: "varchar", is_nullable: true, is_primary_key: false, column_default: null, extra: null },
      ],
      primaryKeys: ["id"],
    });

    await store.executeTabSql(tabId, "SELECT id, name FROM users LIMIT 100", {
      pagination: { limit: 100, offset: 0 },
    });

    expect(buildDataGridCountSql).toHaveBeenCalledWith({
      databaseType: "mysql",
      identifierQuote: undefined,
      catalog: undefined,
      schema: "public",
      tableName: "users",
      whereInput: undefined,
    });
    await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledWith("mysql-1", "app", "SELECT COUNT(*) FROM `users`", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 })));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultTotalRowCount).toBe(123));
    expect(tab.resultTotalRowCountLoading).toBe(false);
  });
});
