import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const beginManualTransaction = vi.fn();
const executeInManualTransaction = vi.fn();
const cancelQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const listTables = vi.fn();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability,
  buildDataGridCountSql,
  buildSortedQuerySql,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  beginManualTransaction,
  cancelQuery,
  executeInManualTransaction,
  executeMulti,
  executeQuery,
  getColumns,
  listIndexes,
  listObjects,
  listTables,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
    // 与真实 store 一致：setTableMeta 写入 tableMeta 时记录连接元数据代次
    metadataGenerationFor: () => 0,
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
    listTables.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
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
    cancelQuery.mockResolvedValue(false);
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "__DBX_PK_0"],
        rows: [["Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
    beginManualTransaction.mockResolvedValue("txn-1");
    executeInManualTransaction.mockResolvedValue([
      {
        columns: ["name", "__DBX_PK_0"],
        rows: [["Alice", 7]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
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
  }, 10_000);

  it("keeps MySQL expression columns read-only without disabling direct columns", async () => {
    const sql = "SELECT id, status, extra->>'$.mode' mode, extra->>'$.template' tmpl FROM items";
    getColumns.mockResolvedValue([
      { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "status", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "extra", data_type: "json", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "items",
        selectStar: false,
        columns: [
          { sourceName: "id", resultName: "id", expression: "id" },
          { sourceName: "status", resultName: "status", expression: "status" },
          { sourceName: undefined, resultName: "mode", expression: "extra->>'$.mode'" },
          { sourceName: undefined, resultName: "tmpl", expression: "extra->>'$.template'" },
        ],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["id", "status", "mode", "tmpl"], rows: [[1, "ok", "fast", "base"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, sql);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["id", "status", undefined, undefined]));
    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("starts a qualified MySQL star query before slow column metadata finishes", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getColumns.mockReturnValue(columnsGate.promise);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "sys_dept",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["dept_id", "dept_name"],
        rows: [[1, "Headquarters"]],
        affected_rows: 0,
        execution_time_ms: 12,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    const execution = store.executeTabSql(tabId, "SELECT sys_dept.* FROM sys_dept");
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalled());
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT sys_dept.* FROM sys_dept", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));

    columnsGate.resolve([
      { name: "dept_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "dept_name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    await execution;
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("sys_dept"));
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

  it("keeps insert disabled when a MySQL table has a physical primary key named like DBX ROWID", async () => {
    getColumns.mockResolvedValue([
      { name: "__DBX_ROWID", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        selectStar: false,
        columns: [{ sourceName: "name", resultName: "name", expression: "name" }, ...(sql.includes("__DBX_PK_0") ? [{ sourceName: "__DBX_ROWID", resultName: "__DBX_PK_0", expression: "`__DBX_ROWID`" }] : [])],
      },
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "__DBX_ROWID"]));
    expect(tab.queryAnalysis?.allowInsert).toBe(false);
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

  it("starts a MySQL JDBC star query before slow column metadata finishes", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getConnectionConfig.mockReturnValue({ id: "jdbc-1", name: "JDBC MySQL", db_type: "jdbc", connection_string: "jdbc:mysql://localhost:3306/app", database: "app", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "sys_dept",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["dept_id", "dept_name"],
        rows: [[1, "Headquarters"]],
        affected_rows: 0,
        execution_time_ms: 12,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-1", "", "Query");

    const execution = store.executeTabSql(tabId, "SELECT * FROM sys_dept");
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalled());
    expect(executeMulti).toHaveBeenCalledWith("jdbc-1", "", "SELECT * FROM sys_dept", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));

    columnsGate.resolve([
      { name: "dept_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "dept_name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    await execution;
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("sys_dept"));
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

  it("executes a constant projection without waiting for Oracle table metadata", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([{ name: "DUMMY", data_type: "VARCHAR2(1)", is_nullable: true, column_default: null, is_primary_key: false, extra: null }]);
    listIndexes.mockResolvedValue([]);
    listTables.mockReturnValue(new Promise(() => undefined));
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "DUAL",
        selectStar: false,
        columns: [{ resultName: "1", expression: "1" }],
      },
    });
    const result = [{ columns: ["1"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }];
    const executionGate = deferred<typeof result>();
    executeMulti.mockReturnValue(executionGate.promise);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);
    const sql = "SELECT 1 FROM DUAL";

    const execution = store.executeTabSql(tabId, sql);
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalled(), { timeout: 250 });

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", sql, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(getColumns).not.toHaveBeenCalled();
    expect(listIndexes).not.toHaveBeenCalled();
    expect(listTables).not.toHaveBeenCalled();

    executionGate.resolve(result);
    await execution;
  });

  it("uses a hidden Oracle ROWID to keep keyless base-table query results editable", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PLATFORM", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue([
      { name: "TT_PLATFORM_CARS", type: "view", schema: "REPORTING" },
      { name: "TT_PLATFORM_CARS", type: "table", schema: "SH_SMCVDMS_OVERSEAS_DRSSITB" },
    ]);
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
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT t.* FROM SH_SMCVDMS_OVERSEAS_DRSSITB.TT_PLATFORM_CARS t WHERE t.PLATFORM = '轻卡'");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT t.*, ROWIDTOCHAR(ROWID) AS \"__DBX_PK_0\" FROM SH_SMCVDMS_OVERSEAS_DRSSITB.TT_PLATFORM_CARS t WHERE t.PLATFORM = '轻卡'", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(lookupLocalCompletionTables).toHaveBeenCalledWith("oracle-1", "ORCL", "TT_PLATFORM_CARS", 20, "SH_SMCVDMS_OVERSEAS_DRSSITB", undefined);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([2]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["ID", "PLATFORM", "__DBX_ROWID"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryAnalysis?.allowInsert).not.toBe(false);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it.each([
    {
      connection: { id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 },
      label: "native Oracle",
    },
    {
      connection: { id: "oracle-jdbc-1", name: "Oracle JDBC", db_type: "jdbc", connection_string: "jdbc:oracle:thin:@//localhost:1521/ORCL", database: "ORCL", query_timeout_secs: 30 },
      label: "Oracle-inferred JDBC",
    },
  ])("uses a physical primary index for $label star projections when column flags omit it", async ({ connection }) => {
    getConnectionConfig.mockReturnValue(connection);
    getColumns.mockResolvedValue([
      { name: "OFFER_RELA_ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "ORI_OFFER_ID", data_type: "NUMBER", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([{ name: "PK_OFFER_RELA", columns: ["OFFER_RELA_ID"], is_unique: true, is_primary: true }]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "OFFER_RELA", type: "table", schema: "APP" }]);

    const projections = [
      {
        sql: "SELECT T.* FROM APP.OFFER_RELA t",
        analysisColumns: [],
        resultColumns: ["OFFER_RELA_ID", "ORI_OFFER_ID"],
        sourceColumns: undefined,
        selectStar: true,
      },
      {
        sql: "SELECT T.*, T.ROWID FROM APP.OFFER_RELA t",
        analysisColumns: [
          { star: true, sourceQualifier: "T", sourceKey: "t:0", resultName: "*", expression: "T.*" },
          { sourceName: "ROWID", sourceNameQuoted: false, sourceQualifier: "T", sourceKey: "t:0", resultName: "ROWID", expression: "T.ROWID" },
        ],
        resultColumns: ["OFFER_RELA_ID", "ORI_OFFER_ID", "ROWID"],
        sourceColumns: ["OFFER_RELA_ID", "ORI_OFFER_ID", undefined],
        selectStar: false,
      },
    ];

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    for (const projection of projections) {
      analyzeEditableQueryEditability.mockResolvedValue({
        editable: true,
        analysis: {
          schema: "APP",
          tableName: "OFFER_RELA",
          tableAlias: "t",
          selectStar: projection.selectStar,
          columns: projection.analysisColumns,
        },
      });
      executeMulti.mockResolvedValue([
        {
          columns: projection.resultColumns,
          rows: [],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      ]);

      const tabId = store.createTab(connection.id, "ORCL", "Query");
      store.setAutoCommit(tabId, true);
      await store.executeTabSql(tabId, projection.sql);

      expect(executeMulti).toHaveBeenLastCalledWith(connection.id, "ORCL", projection.sql, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
      const tab = store.tabs.find((item) => item.id === tabId)!;
      if (projection.sourceColumns) {
        await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(projection.sourceColumns));
      } else {
        expect(tab.querySourceColumns).toBeUndefined();
      }
      await vi.waitFor(() => expect(tab.tableMeta?.primaryKeys).toEqual(["OFFER_RELA_ID"]));
      expect(tab.queryAnalysis).toBeDefined();
      expect(tab.queryEditabilityReason).toBeUndefined();
    }
  });

  it("uses the configured current schema to keep an unqualified Oracle base-table query editable", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", default_schema: "APP", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue([
      { name: "CUSTOMERS", type: "view", schema: "REPORTING" },
      { name: "CUSTOMERS", type: "table", schema: "APP" },
    ]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: undefined,
          tableName: "CUSTOMERS",
          selectStar: !hidden,
          columns: hidden
            ? [
                { star: true, sourceKey: "CUSTOMERS:0", resultName: "*", expression: "*" },
                { resultName: "__DBX_PK_0", expression: "ROWIDTOCHAR(ROWID)" },
              ]
            : [],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "NAME", "__DBX_PK_0"],
        rows: [[1, "Alice", "AAAPr9AAEAAAACXAAA"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM CUSTOMERS");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", 'SELECT CUSTOMERS.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM CUSTOMERS', undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(lookupLocalCompletionTables).toHaveBeenCalledWith("oracle-1", "ORCL", "CUSTOMERS", 20, "APP", undefined);
    expect(store.tabs.find((item) => item.id === tabId)?.result?.hidden_column_indexes).toEqual([2]);
  });

  it("resolves the Oracle current schema before adding ROWID to an unqualified keyless table query", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listTables.mockResolvedValue([{ name: "CUSTOMERS", table_type: "TABLE" }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => {
      const hidden = sql.includes("__DBX_PK_0");
      return {
        editable: true,
        analysis: {
          schema: undefined,
          tableName: "CUSTOMERS",
          selectStar: !hidden,
          columns: hidden
            ? [
                { star: true, sourceKey: "CUSTOMERS:0", resultName: "*", expression: "*" },
                { resultName: "__DBX_PK_0", expression: "ROWIDTOCHAR(ROWID)" },
              ]
            : [],
        },
      };
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "NAME", "__DBX_PK_0"],
        rows: [[1, "Alice", "AAAPr9AAEAAAACXAAA"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM CUSTOMERS");

    expect(listTables).toHaveBeenCalledWith("oracle-1", "ORCL", "", "CUSTOMERS");
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", 'SELECT CUSTOMERS.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM CUSTOMERS', undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(store.tabs.find((item) => item.id === tabId)?.result?.hidden_column_indexes).toEqual([2]);
    await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]));

    await store.executeTabSql(tabId, "SELECT * FROM CUSTOMERS");
    expect(listTables).toHaveBeenCalledOnce();
  });

  it("keeps an unqualified Oracle view read-only after resolving it in the current schema", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listTables.mockResolvedValue([{ name: "CUSTOMERS", table_type: "VIEW" }]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "CUSTOMERS",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ID", "NAME"], rows: [[1, "Alice"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM CUSTOMERS");

    expect(listTables).toHaveBeenCalledWith("oracle-1", "ORCL", "", "CUSTOMERS");
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM CUSTOMERS", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(store.tabs.find((item) => item.id === tabId)?.result?.hidden_column_indexes).toBeUndefined();
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
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM aa");

    expect(getColumns).toHaveBeenCalledWith("oracle-1", "ORCL", "", "AA", undefined);
    expect(listIndexes).toHaveBeenCalledWith("oracle-1", "ORCL", "", "AA", undefined);
    expect(listObjects).not.toHaveBeenCalled();
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM aa", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
  });

  it("executes an Oracle cache-miss query without waiting for object discovery", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ncdb", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PRODUCT_NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    listObjects.mockReturnValue(new Promise(() => undefined));
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "VITF_PRODUCT_INFOOA",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "PRODUCT_NAME"],
        rows: [],
        affected_rows: 0,
        execution_time_ms: 473,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ncdb", "Query");
    store.setAutoCommit(tabId, true);
    const sql = "SELECT * FROM VITF_PRODUCT_INFOOA WHERE PK_MATERIAL IN ('1', '2')";

    const execution = store.executeTabSql(tabId, sql);
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ncdb", sql, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 })), { timeout: 1000 });
    await execution;

    expect(lookupLocalCompletionTables).not.toHaveBeenCalled();
  });

  it("starts an Oracle primary-key star query before slow column metadata finishes", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    listIndexes.mockResolvedValue([{ name: "PK_WIDE_TABLE", columns: ["ID"], is_unique: true, is_primary: true }]);
    analyzeEditableQueryEditability.mockImplementation(async () => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "WIDE_TABLE",
        tableAlias: "t",
        selectStar: true,
        columns: [],
      },
    }));
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "NAME"],
        rows: [[1, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 312,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);

    const execution = store.executeTabSql(tabId, "SELECT t.* FROM APP.WIDE_TABLE t");
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalled());
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT t.* FROM APP.WIDE_TABLE t", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(executeMulti.mock.calls[0]?.[5]).not.toHaveProperty("tableDataPreview");

    columnsGate.resolve([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    await execution;
  });

  it("starts an Oracle star query when index metadata exceeds the preflight budget", async () => {
    vi.useFakeTimers();
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    const indexesGate = deferred<Awaited<ReturnType<typeof listIndexes>>>();
    try {
      getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
      getColumns.mockReturnValue(columnsGate.promise);
      listIndexes.mockReturnValue(indexesGate.promise);
      analyzeEditableQueryEditability.mockImplementation(async () => ({
        editable: true,
        analysis: {
          schema: "APP",
          tableName: "SLOW_METADATA_TABLE",
          selectStar: true,
          columns: [],
        },
      }));
      executeMulti.mockResolvedValue([
        {
          columns: ["ID", "NAME"],
          rows: [[1, "Alice"]],
          affected_rows: 0,
          execution_time_ms: 12,
        },
      ]);

      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();
      const tabId = store.createTab("oracle-1", "ORCL", "Query");
      store.setAutoCommit(tabId, true);

      const execution = store.executeTabSql(tabId, "SELECT * FROM APP.SLOW_METADATA_TABLE");
      await vi.waitFor(() => expect(listIndexes).toHaveBeenCalledOnce());
      expect(executeMulti).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(executeMulti).toHaveBeenCalledOnce());
      expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM APP.SLOW_METADATA_TABLE", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
      await execution;

      indexesGate.resolve([{ name: "PK_SLOW_METADATA_TABLE", columns: ["ID"], is_unique: true, is_primary: true }]);
      columnsGate.resolve([
        { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ]);
      await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.tableMeta?.primaryKeys).toEqual(["ID"]));

      await store.executeTabSql(tabId, "SELECT * FROM APP.SLOW_METADATA_TABLE");
      expect(executeMulti).toHaveBeenCalledTimes(2);
      expect(listIndexes).toHaveBeenCalledOnce();
      expect(getColumns).toHaveBeenCalledOnce();
    } finally {
      indexesGate.resolve([{ name: "PK_SLOW_METADATA_TABLE", columns: ["ID"], is_unique: true, is_primary: true }]);
      columnsGate.resolve([
        { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ]);
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("waits for first-run Oracle XMLTYPE metadata before manual transaction execution", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    listIndexes.mockResolvedValue([{ name: "PK_WIDE_TABLE", columns: ["ID"], is_unique: true, is_primary: true }]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "WIDE_TABLE", type: "table", schema: "APP" }]);
    analyzeEditableQueryEditability.mockImplementation(async () => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "WIDE_TABLE",
        tableAlias: "t",
        selectStar: true,
        columns: [],
      },
    }));
    executeInManualTransaction.mockResolvedValue([
      {
        columns: ["ID", "PAYLOAD"],
        rows: [[1, "<XMLTYPE>"]],
        affected_rows: 0,
        execution_time_ms: 1,
        large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 81920 }],
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    // Tabs default to auto-commit; exercise the explicit manual-transaction path.
    store.setAutoCommit(tabId, false);
    const execution = store.executeTabSql(tabId, "SELECT t.* FROM APP.WIDE_TABLE t");

    await vi.waitFor(() => expect(listIndexes).toHaveBeenCalled());
    expect(executeInManualTransaction).not.toHaveBeenCalled();

    columnsGate.resolve([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "PAYLOAD", data_type: "SYS.XMLTYPE", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    await execution;

    expect(beginManualTransaction).toHaveBeenCalledWith("oracle-1", "ORCL", undefined, undefined);
    expect(executeInManualTransaction).toHaveBeenCalledWith("txn-1", "SELECT t.* FROM APP.WIDE_TABLE t", "ORCL", undefined, expect.any(Number), true, undefined, undefined, "SELECT t.* FROM APP.WIDE_TABLE t");
    expect(store.tabs.find((tab) => tab.id === tabId)?.result?.large_value_cells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 81920 }]);
  });

  it("continues the Oracle cursor for page 2 in a manual transaction", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: true,
    }));
    executeInManualTransaction
      .mockResolvedValueOnce([
        {
          columns: ["ID"],
          rows: Array.from({ length: 100 }, (_, index) => [index + 1]),
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: "oracle-go-1",
          has_more: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          columns: ["ID"],
          rows: Array.from({ length: 100 }, (_, index) => [index + 101]),
          affected_rows: 0,
          execution_time_ms: 1,
          has_more: false,
        },
      ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    // Tabs default to auto-commit; exercise the explicit manual-transaction path.
    store.setAutoCommit(tabId, false);
    const sql = "SELECT ID FROM APP.EVENTS ORDER BY ID";

    await store.executeTabSql(tabId, sql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(false);
    expect(executeInManualTransaction).toHaveBeenNthCalledWith(1, "txn-1", sql, "ORCL", undefined, expect.any(Number), false, 100, undefined, sql);
    expect(tab.result?.rows).toHaveLength(100);

    await store.executeTabSql(tabId, sql, {
      resultBaseSql: sql,
      pagination: { limit: 100, offset: 100, sessionId: "oracle-go-1" },
      appendResult: { maxRows: 10_000 },
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
    });

    expect(executeInManualTransaction).toHaveBeenNthCalledWith(2, "txn-1", sql, "ORCL", undefined, expect.any(Number), false, 100, "oracle-go-1", undefined);
    expect(tab.result?.rows).toHaveLength(200);
    expect(tab.result?.rows[100]).toEqual([101]);
  });

  it("does not start an Oracle manual transaction after cancellation during metadata loading", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    listIndexes.mockResolvedValue([{ name: "PK_WIDE_TABLE", columns: ["ID"], is_unique: true, is_primary: true }]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "WIDE_TABLE", type: "table", schema: "APP" }]);
    analyzeEditableQueryEditability.mockImplementation(async () => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "WIDE_TABLE",
        tableAlias: "t",
        selectStar: true,
        columns: [],
      },
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    // Tabs default to auto-commit; exercise the explicit manual-transaction path.
    store.setAutoCommit(tabId, false);
    const execution = store.executeTabSql(tabId, "SELECT t.* FROM APP.WIDE_TABLE t");

    await vi.waitFor(() => expect(listIndexes).toHaveBeenCalled());
    await expect(store.cancelTabExecution(tabId)).resolves.toBe(false);

    columnsGate.resolve([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "PAYLOAD", data_type: "SYS.XMLTYPE", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    await expect(execution).resolves.toBe(false);

    expect(cancelQuery).toHaveBeenCalledWith(expect.any(String));
    expect(beginManualTransaction).not.toHaveBeenCalled();
    expect(executeInManualTransaction).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      executionId: undefined,
    });
    expect(store.tabs.find((tab) => tab.id === tabId)?.txnSessionId).toBeUndefined();
  });

  it("keeps manual non-Oracle queries out of table-data preview mode", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeInManualTransaction).toHaveBeenCalledWith("txn-1", "SELECT name, `id` AS `__DBX_PK_0` FROM users", "app", undefined, expect.any(Number), false, undefined, undefined, undefined);
  });

  it("keeps a keyless Oracle query editable when its WHERE clause reads another table", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "CUSTOMER_NO", data_type: "NUMBER", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "PLATFORM_CARS", type: "table", schema: "APP" }]);
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
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);

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
    lookupLocalCompletionTables.mockReturnValue([{ name: "PLATFORM_VIEW", type: "view", schema: "APP" }]);
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
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);
    const tab = store.tabs.find((item) => item.id === tabId)!;

    await store.executeTabSql(tabId, "SELECT * FROM APP.PLATFORM_VIEW");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM APP.PLATFORM_VIEW", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(lookupLocalCompletionTables).toHaveBeenCalledWith("oracle-1", "ORCL", "PLATFORM_VIEW", 20, "APP", undefined);
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
  });

  it.each(["CLOB", "XMLTYPE", "SYS.XMLTYPE"])("enables deferred Oracle %s values only when a base-table query has a stable key", async (dataType) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "PAYLOAD", data_type: dataType, is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "DOCUMENTS", type: "table", schema: "APP" }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "DOCUMENTS",
        selectStar: false,
        columns: [{ sourceName: "PAYLOAD", resultName: "PAYLOAD", expression: "PAYLOAD" }, ...(sql.includes("__DBX_PK_0") ? [{ sourceName: "ID", resultName: "__DBX_PK_0", expression: '"ID"' }] : [])],
      },
    }));
    executeMulti.mockResolvedValue([{ columns: ["PAYLOAD", "__DBX_PK_0"], rows: [["<CLOB>", 1]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT PAYLOAD FROM APP.DOCUMENTS");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", 'SELECT PAYLOAD, "ID" AS "__DBX_PK_0" FROM APP.DOCUMENTS', undefined, expect.any(String), expect.objectContaining({ tableDataPreview: true, timeoutSecs: 30 }));
  });

  it("keeps deferred Oracle LOBs disabled for views", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PAYLOAD", data_type: "CLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "DOCUMENT_VIEW", type: "view", schema: "APP" }]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "DOCUMENT_VIEW",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ID", "PAYLOAD"], rows: [[1, "value"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM APP.DOCUMENT_VIEW");

    expect(executeMulti).toHaveBeenCalledOnce();
    expect(executeMulti.mock.calls[0]?.[5]).not.toHaveProperty("tableDataPreview");
  });

  it("keeps deferred Oracle LOBs disabled when a keyless source has no safe ROWID path", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "PAYLOAD", data_type: "CLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "DOCUMENTS",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ID", "PAYLOAD"], rows: [[1, "value"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM DOCUMENTS");

    expect(executeMulti).toHaveBeenCalledOnce();
    expect(executeMulti.mock.calls[0]?.[5]).not.toHaveProperty("tableDataPreview");
  });

  it("does not request deferred Oracle LOB handling for ordinary non-LOB queries", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "CUSTOMERS", type: "table", schema: "APP" }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "CUSTOMERS",
        selectStar: false,
        columns: [{ sourceName: "NAME", resultName: "NAME", expression: "NAME" }, ...(sql.includes("__DBX_PK_0") ? [{ sourceName: "ID", resultName: "__DBX_PK_0", expression: '"ID"' }] : [])],
      },
    }));
    executeMulti.mockResolvedValue([{ columns: ["NAME", "__DBX_PK_0"], rows: [["Alice", 1]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT NAME FROM APP.CUSTOMERS");

    expect(executeMulti).toHaveBeenCalledOnce();
    expect(executeMulti.mock.calls[0]?.[5]).not.toHaveProperty("tableDataPreview");
  });

  it.each([
    ["only a foreign owner is cached", [{ name: "CUSTOMERS", type: "table", schema: "APP" }]],
    [
      "multiple owners are cached",
      [
        { name: "CUSTOMERS", type: "table", schema: "APP" },
        { name: "CUSTOMERS", type: "table", schema: "REPORTING" },
      ],
    ],
  ])("does not infer the current schema when %s", async (_caseName, cachedTables) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    lookupLocalCompletionTables.mockReturnValue(cachedTables);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "CUSTOMERS",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ID", "NAME"], rows: [[1, "Alice"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM CUSTOMERS");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM CUSTOMERS", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(lookupLocalCompletionTables).not.toHaveBeenCalled();
    expect(store.tabs.find((item) => item.id === tabId)?.result?.hidden_column_indexes).toBeUndefined();
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

    await store.executeTabSql(tabId, "SELECT name FROM users", {
      resultBaseSql: "SELECT name FROM users",
      resultSortedSql: tab.resultSortedSql,
      querySort: {
        resultColumns: ["name"],
        columnIndex: 0,
        column: "name",
        direction: "asc",
      },
      pagination: { offset: 100, limit: 100 },
    });

    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
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
    // Exercise the explicit auto-commit execute-multi path.
    store.setAutoCommit(tabId, true);

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

  it("keeps SQL Server updates unqualified when the SELECT source is unqualified", async () => {
    getConnectionConfig.mockReturnValue({ id: "sqlserver-1", name: "SQL Server 2008", db_type: "sqlserver", database: "cdc", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "a4", data_type: "nvarchar(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "yb_ty_qtxx",
        selectStar: true,
        columns: [{ sourceName: undefined, star: true, resultName: "*", expression: "*" }],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "a4"],
        rows: [[1, "德谷胰岛素利拉鲁肽"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "cdc", "Query", "query", "cdc");

    await store.executeTabSql(tabId, "select * from yb_ty_qtxx where a4 like N'%德谷胰岛素利拉鲁%'");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());
    expect(getColumns).toHaveBeenCalledWith("sqlserver-1", "cdc", "", "yb_ty_qtxx", undefined);
    expect(tab.tableMeta?.database).toBe("cdc");
    expect(tab.tableMeta?.schema).toBeUndefined();
  });

  it("preserves an explicitly qualified SQL Server update source", async () => {
    getConnectionConfig.mockReturnValue({ id: "sqlserver-1", name: "SQL Server 2008", db_type: "sqlserver", database: "cdc", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "sales",
        tableName: "yb_ty_qtxx",
        selectStar: true,
        columns: [{ sourceName: undefined, star: true, resultName: "*", expression: "*" }],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "a4"],
        rows: [[1, "德谷胰岛素利拉鲁肽"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "cdc", "Query", "query", "cdc");

    await store.executeTabSql(tabId, "select * from sales.yb_ty_qtxx");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());
    expect(getColumns).toHaveBeenCalledWith("sqlserver-1", "cdc", "sales", "yb_ty_qtxx", undefined);
    expect(tab.tableMeta?.database).toBe("cdc");
    expect(tab.tableMeta?.schema).toBe("sales");
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

  it.each([
    ["disabled by default", undefined, undefined],
    ["explicitly enabled", { gaussdbCountQueryDop: 8 }, "/*+ set(query_dop 8) */"],
  ])("keeps GaussDB count parallelism %s", async (_label, externalConfig, expectedCountHint) => {
    editorSettings.autoCalculateTotalRows = true;
    getConnectionConfig.mockReturnValue({
      id: "gaussdb-1",
      name: "GaussDB",
      db_type: "gaussdb",
      database: "app",
      query_timeout_secs: 30,
      external_config: externalConfig,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "name"],
        rows: Array.from({ length: 100 }, (_, index) => [index + 1, `user-${index + 1}`]),
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("gaussdb-1", "app", "users", "data", "public");
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

    await vi.waitFor(() =>
      expect(buildDataGridCountSql).toHaveBeenCalledWith({
        databaseType: "gaussdb",
        identifierQuote: undefined,
        catalog: undefined,
        database: undefined,
        schema: "public",
        tableName: "users",
        whereInput: undefined,
        countHint: expectedCountHint,
      }),
    );
  });

  it("stops appending when a SQL Server query has no bounded next-page plan", async () => {
    getConnectionConfig.mockReturnValue({ id: "sqlserver-1", name: "SQL Server", db_type: "sqlserver", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    const rows = Array.from({ length: 28 }, (_, index) => [index + 1]);
    executeMulti.mockResolvedValueOnce([
      {
        columns: ["id"],
        rows,
        affected_rows: 28,
        execution_time_ms: 1,
        has_more: true,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "app", "Query");
    const sql = "SELECT a.id, b.* FROM orders a JOIN order_details b ON b.order_id = a.id";

    await store.executeTabSql(tabId, sql);
    expect(executeMulti).toHaveBeenCalledTimes(1);

    await store.executeTabSql(tabId, sql, {
      resultBaseSql: sql,
      pagination: { limit: 25, offset: 28 },
      appendResult: { maxRows: 10_000 },
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
    });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(executeMulti).toHaveBeenCalledTimes(1);
    expect(tab.result?.rows).toEqual(rows);
    expect(tab.result?.has_more).toBe(false);
  });
});
