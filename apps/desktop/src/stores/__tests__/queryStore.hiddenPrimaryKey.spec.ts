import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveVirtualRowIdentifier } from "@/lib/table/virtualRowIdentifier";

const apiMocks = vi.hoisted(() => ({
  localStorageValues: new Map<string, string>(),
  executeMulti: vi.fn(),
  executeQuery: vi.fn(),
  beginManualTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  closeQuerySession: vi.fn().mockResolvedValue(false),
  closeClientConnectionSession: vi.fn().mockResolvedValue(false),
  cancelQuery: vi.fn(),
  analyzeEditableQueryEditability: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listObjects: vi.fn(),
  listTables: vi.fn(),
  getConnectionConfig: vi.fn(),
  lookupLocalCompletionTables: vi.fn(),
  buildSortedQuerySql: vi.fn(),
  buildDataGridCountSql: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options: { sql: string }) => ({
    sqlToExecute: options.sql,
    pageSql: undefined,
    pageLimit: undefined,
    pageOffset: undefined,
    countSql: undefined,
    useAgentResultSession: false,
  })),
  editorSettings: {
    pageSize: 100,
    autoCalculateTotalRows: false,
    queryResultMaxRowsEnabled: true,
    queryResultMaxRows: 100_000,
  },
}));
const {
  localStorageValues,
  executeMulti,
  executeQuery,
  beginManualTransaction,
  executeInManualTransaction,
  closeQuerySession,
  closeClientConnectionSession,
  cancelQuery,
  analyzeEditableQueryEditability,
  getColumns,
  listIndexes,
  listObjects,
  listTables,
  getConnectionConfig,
  lookupLocalCompletionTables,
  buildSortedQuerySql,
  buildDataGridCountSql,
  prepareQueryPaginationExecutionPlan,
  editorSettings,
} = apiMocks;
vi.stubGlobal("localStorage", {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageValues.set(key, value),
  removeItem: (key: string) => localStorageValues.delete(key),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: apiMocks.analyzeEditableQueryEditability,
  buildDataGridCountSql: apiMocks.buildDataGridCountSql,
  buildSortedQuerySql: apiMocks.buildSortedQuerySql,
  closeClientConnectionSession: apiMocks.closeClientConnectionSession,
  closeQuerySession: apiMocks.closeQuerySession,
  beginManualTransaction: apiMocks.beginManualTransaction,
  cancelQuery: apiMocks.cancelQuery,
  executeInManualTransaction: apiMocks.executeInManualTransaction,
  executeMulti: apiMocks.executeMulti,
  executeQuery: apiMocks.executeQuery,
  getColumns: apiMocks.getColumns,
  listIndexes: apiMocks.listIndexes,
  listObjects: apiMocks.listObjects,
  listTables: apiMocks.listTables,
  prepareQueryPaginationExecutionPlan: apiMocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: apiMocks.getConnectionConfig,
    lookupLocalCompletionTables: apiMocks.lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
    // 与真实 store 一致：setTableMeta 写入 tableMeta 时记录连接元数据代次
    metadataGenerationFor: () => 0,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: apiMocks.editorSettings,
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
    closeQuerySession.mockResolvedValue(false);
    closeClientConnectionSession.mockResolvedValue(false);
    localStorageValues.clear();
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
    editorSettings.queryResultMaxRowsEnabled = true;
    editorSettings.queryResultMaxRows = 100_000;
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

  it("falls back to the original SQL for non-Oracle databases when editability metadata exceeds the preflight budget", async () => {
    // 慢元数据：列/索引加载永不在预算内返回，触发对所有数据库统一施加的 1s preflight 预算超时。
    // 泛化前仅 Oracle/Xugu 有此预算，MySQL 等会被慢元数据阻塞到结果显示。
    getColumns.mockReturnValue(deferred<never[]>().promise);
    listIndexes.mockReturnValue(deferred<never[]>().promise);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    // 预算超时后先出结果：执行原始 SQL、未注入隐藏主键（可编辑能力随后台加载补齐）。
    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
  }, 10_000);

  it.each((["dameng", "jdbc"] as const).flatMap((dbType) => [true, false].flatMap((autoCommit) => [true, false].map((returnsPrimaryKey) => ({ dbType, autoCommit, returnsPrimaryKey })))))(
    "dispatches cold Dameng SQL before metadata with $dbType, autoCommit=$autoCommit, returnsPrimaryKey=$returnsPrimaryKey",
    async ({ dbType, autoCommit, returnsPrimaryKey }) => {
      const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
      const resultGate = deferred<Awaited<ReturnType<typeof executeMulti>>>();
      getConnectionConfig.mockReturnValue({ id: "dameng-1", name: "Dameng", db_type: dbType, driver_profile: "dameng", database: "SYSDBA", query_timeout_secs: 30 });
      const columns = [
        { name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "NAME", data_type: "VARCHAR(50)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ];
      const resultColumns = returnsPrimaryKey ? ["ID", "NAME"] : ["NAME"];
      const sql = `SELECT ${resultColumns.join(", ")} FROM APP.USERS`;
      analyzeEditableQueryEditability.mockResolvedValue({
        editable: true,
        analysis: { schema: "APP", tableName: "USERS", selectStar: false, columns: resultColumns.map((name) => ({ sourceName: name, resultName: name, expression: name })) },
      });
      getColumns.mockReturnValue(columnsGate.promise);
      executeMulti.mockReturnValue(resultGate.promise);
      executeInManualTransaction.mockReturnValue(resultGate.promise);

      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();
      const tabId = store.createTab("dameng-1", "SYSDBA", "Query");
      store.setAutoCommit(tabId, autoCommit);
      const tab = store.tabs.find((item) => item.id === tabId)!;
      const execution = store.executeTabSql(tabId, sql);
      const dispatch = autoCommit ? executeMulti : executeInManualTransaction;
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(dispatch.mock.calls[0]?.[autoCommit ? 2 : 1]).toBe(sql);
      expect(getColumns).not.toHaveBeenCalled();
      expect(listIndexes).not.toHaveBeenCalled();

      resultGate.resolve([{ columns: resultColumns, rows: [returnsPrimaryKey ? [1, "Alice"] : ["Alice"]], affected_rows: 0, execution_time_ms: 1 }]);
      await execution;
      expect(tab.isExecuting).toBe(false);
      expect(tab.result?.columns).toEqual(resultColumns);
      expect(tab.queryAnalysis).toBeUndefined();
      await vi.waitFor(() => expect(getColumns).toHaveBeenCalledOnce());

      columnsGate.resolve(columns);
      await vi.waitFor(() => expect(tab.tableMeta?.primaryKeys).toEqual(["ID"]));
      expect(tab.result?.columns).toEqual(resultColumns);
      if (returnsPrimaryKey) {
        expect(tab.queryAnalysis).toBeDefined();
        expect(tab.queryEditabilityReason).toBeUndefined();
      } else {
        expect(tab.queryAnalysis).toBeUndefined();
        expect(tab.queryEditabilityReason).toBe("primary-key-not-returned");
      }
    },
  );

  it("does not apply delayed Dameng metadata to a newer result", async () => {
    const firstColumns = deferred<Awaited<ReturnType<typeof getColumns>>>();
    const columns = [
      { name: "ID", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "NAME", data_type: "VARCHAR(50)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ];
    getConnectionConfig.mockReturnValue({ id: "dameng-1", name: "Dameng", db_type: "dameng", database: "SYSDBA", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: { schema: "APP", tableName: sql.includes("ARCHIVE") ? "ARCHIVE" : "USERS", selectStar: false, columns: ["ID", "NAME"].map((name) => ({ sourceName: name, resultName: name, expression: name })) },
    }));
    getColumns.mockImplementation((_connectionId: string, _database: string, _schema: string, table: string) => (table === "USERS" ? firstColumns.promise : Promise.resolve(columns)));
    executeMulti.mockResolvedValueOnce([{ columns: ["ID", "NAME"], rows: [[1, "Alice"]], affected_rows: 0, execution_time_ms: 1 }]);
    executeMulti.mockResolvedValueOnce([{ columns: ["ID", "NAME"], rows: [[2, "Bob"]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("dameng-1", "SYSDBA", "Query");
    store.setAutoCommit(tabId, true);
    const tab = store.tabs.find((item) => item.id === tabId)!;

    await store.executeTabSql(tabId, "SELECT ID, NAME FROM APP.USERS");
    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledOnce());
    await store.executeTabSql(tabId, "SELECT ID, NAME FROM APP.ARCHIVE");
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("ARCHIVE"));
    const newerMetadata = tab.tableMeta;

    firstColumns.resolve(columns);
    const { loadTableMetadata } = await import("@/lib/metadata/tableMetadataCache");
    await loadTableMetadata({ connectionId: "dameng-1", database: "SYSDBA", schema: "APP", tableName: "USERS", databaseType: "dameng" });
    expect(tab.tableMeta).toBe(newerMetadata);
    expect(tab.tableMeta?.tableName).toBe("ARCHIVE");
    expect(tab.result?.rows).toEqual([[2, "Bob"]]);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps a successful Dameng result available when background metadata fails", async () => {
    getConnectionConfig.mockReturnValue({ id: "dameng-1", name: "Dameng", db_type: "dameng", database: "SYSDBA", query_timeout_secs: 30 });
    getColumns.mockRejectedValue(new Error("dictionary unavailable"));
    executeMulti.mockResolvedValue([{ columns: ["name"], rows: [["Alice"]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("dameng-1", "SYSDBA", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT name FROM users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("metadata-unavailable"));
    expect(tab.isExecuting).toBe(false);
    expect(tab.error).toBeUndefined();
    expect(tab.result?.rows).toEqual([["Alice"]]);
    expect(tab.queryAnalysis).toBeUndefined();
  });

  it("appends the cached hidden primary key for Dameng tables whose columns keep the created case", async () => {
    // #10233: Dameng keeps the case an unquoted identifier was created with, so the
    // server reports `name` while the Oracle-family dialect handling folds the SQL
    // token to `NAME`. The binding has to survive that mismatch, otherwise the result
    // stays read-only even though the table has a primary key.
    getConnectionConfig.mockReturnValue({ id: "dameng-1", name: "Dameng", db_type: "dameng", database: "SYSDBA", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "VARCHAR(50)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    // Mirror what the analyzer reports for this dialect: the user's unquoted token
    // keeps its spelling and quoting flag (the store then folds it, like the real
    // Oracle-family path), while the hidden key dbx appends is quoted as `"id"`.
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        selectStar: false,
        columns: [{ sourceName: "name", sourceNameQuoted: false, resultName: "name", expression: "name" }, ...(sql.includes("__DBX_PK_0") ? [{ sourceName: "id", sourceNameQuoted: true, resultName: "__DBX_PK_0", expression: '"id"' }] : [])],
      },
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("dameng-1", "SYSDBA", "Query");
    executeMulti.mockResolvedValueOnce([{ columns: ["name"], rows: [["Alice"]], affected_rows: 0, execution_time_ms: 1 }]);

    await store.executeTabSql(tabId, "SELECT name FROM users");
    expect(executeMulti).toHaveBeenCalledWith("dameng-1", "SYSDBA", "SELECT name FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.queryEditabilityReason).toBe("primary-key-not-returned"));

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeMulti).toHaveBeenLastCalledWith("dameng-1", "SYSDBA", 'SELECT name, "id" AS "__DBX_PK_0" FROM users', undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
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
    { databaseType: "mysql" as const, suffix: "/* GROUP BY name HAVING COUNT(*) > 1 */" },
    { databaseType: "mysql" as const, suffix: "-- GROUP BY name" },
    { databaseType: "mysql" as const, suffix: "WHERE name = 'GROUP BY name HAVING COUNT(*)'" },
    { databaseType: "mysql" as const, suffix: "WHERE id IN (SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1)" },
    { databaseType: "oracle" as const, suffix: "/* GROUP BY name HAVING COUNT(*) > 1 */" },
    { databaseType: "oracle" as const, suffix: "-- GROUP BY name" },
    { databaseType: "oracle" as const, suffix: "WHERE name = 'GROUP BY name HAVING COUNT(*)'" },
    { databaseType: "oracle" as const, suffix: "WHERE id IN (SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1)" },
  ])("keeps omitted-key editing for $databaseType with nonstructural grouping text: $suffix", async ({ databaseType, suffix }) => {
    const connectionId = `${databaseType}-1`;
    const database = databaseType === "oracle" ? "ORCL" : "app";
    getConnectionConfig.mockReturnValue({ id: connectionId, name: databaseType, db_type: databaseType, database, query_timeout_secs: 30 });
    const { analyzeEditableQueryEditability: analyzeSqlEditability } = await import("@/lib/sql/sqlAnalysis");
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => analyzeSqlEditability(sql));
    const hiddenKey = databaseType === "oracle" ? '"id" AS "__DBX_PK_0"' : "`id` AS `__DBX_PK_0`";
    executeMulti.mockResolvedValue([{ columns: ["name", "__DBX_PK_0"], rows: [["Alice", 7]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab(connectionId, database, "Query");
    store.setAutoCommit(tabId, true);
    const sql = `SELECT name FROM users ${suffix}`;

    for (let execution = 0; execution < 2; execution++) {
      await store.executeTabSql(tabId, sql);
      expect(executeMulti).toHaveBeenLastCalledWith(connectionId, database, `SELECT name, ${hiddenKey} FROM users ${suffix}`, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
      const tab = store.tabs.find((item) => item.id === tabId)!;
      await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "id"]));
      expect(tab.queryAnalysis).toBeDefined();
      expect(tab.queryEditabilityReason).toBeUndefined();
      expect(tab.result?.hidden_column_indexes).toEqual([1]);
    }
  });

  it("keeps hidden-key editing for quoted grouping identifiers", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "id", data_type: "NUMBER", is_nullable: false, is_primary_key: true },
      { name: "GROUP", data_type: "VARCHAR2", is_nullable: true, is_primary_key: false },
      { name: "HAVING", data_type: "VARCHAR2", is_nullable: true, is_primary_key: false },
      { name: "name", data_type: "VARCHAR2", is_nullable: true, is_primary_key: false },
    ]);
    const { analyzeEditableQueryEditability: analyzeSqlEditability } = await import("@/lib/sql/sqlAnalysis");
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => analyzeSqlEditability(sql));
    executeMulti.mockResolvedValue([{ columns: ["GROUP", "HAVING", "name", "__DBX_PK_0"], rows: [["a", "b", "Alice", 7]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, 'SELECT "GROUP", "HAVING", name FROM users');
    expect(executeMulti.mock.calls.at(-1)?.[2]).toContain('"id" AS "__DBX_PK_0"');
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["GROUP", "HAVING", "name", "id"]));
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps keyless Oracle ROWID editing when comments mention grouping", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", default_schema: "APP", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([{ name: "NAME", data_type: "VARCHAR2", is_nullable: true, is_primary_key: false }]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "USERS", schema: "APP", type: "table" }]);
    const { analyzeEditableQueryEditability: analyzeSqlEditability } = await import("@/lib/sql/sqlAnalysis");
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => analyzeSqlEditability(sql));
    executeMulti.mockResolvedValue([{ columns: ["NAME", "__DBX_PK_0"], rows: [["Alice", "rowid-1"]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT NAME FROM APP.USERS /* GROUP BY NAME HAVING COUNT(*) > 1 */");
    expect(executeMulti.mock.calls.at(-1)?.[2]).toContain('ROWIDTOCHAR(ROWID) AS "__DBX_PK_0"');
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["NAME", "__DBX_ROWID"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it.each([
    { databaseType: "mysql" as const, returnedKey: false },
    { databaseType: "mysql" as const, returnedKey: true },
    { databaseType: "oracle" as const, returnedKey: false },
    { databaseType: "oracle" as const, returnedKey: true },
  ])("keeps scalar-subquery projections editable for $databaseType with returnedKey=$returnedKey", async ({ databaseType, returnedKey }) => {
    const connectionId = `${databaseType}-1`;
    const database = databaseType === "oracle" ? "ORCL" : "app";
    getConnectionConfig.mockReturnValue({ id: connectionId, name: databaseType, db_type: databaseType, database, query_timeout_secs: 30 });
    const { analyzeEditableQueryEditability: analyzeSqlEditability } = await import("@/lib/sql/sqlAnalysis");
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => analyzeSqlEditability(sql));
    const columns = returnedKey ? ["id", "name", "total"] : ["name", "total", "__DBX_PK_0"];
    const rows = returnedKey ? [[7, "Alice", 2]] : [["Alice", 2, 7]];
    executeMulti.mockResolvedValue([{ columns, rows, affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab(connectionId, database, "Query");
    store.setAutoCommit(tabId, true);
    const sql = `SELECT ${returnedKey ? "u.id, " : ""}u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS total FROM users u`;

    await store.executeTabSql(tabId, sql);
    if (returnedKey) {
      expect(executeMulti).toHaveBeenLastCalledWith(connectionId, database, sql, undefined, expect.any(String), expect.any(Object));
    } else {
      expect(executeMulti.mock.calls.at(-1)?.[2]).toContain("__DBX_PK_0");
    }
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(returnedKey ? ["id", "name", undefined] : ["name", undefined, "id"]));
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
    expect(tab.queryAnalysis?.columns.find((column) => column.resultName === "total")?.sourceName).toBeUndefined();
  });

  it.each(["SELECT name FROM users GROUP BY name", "SELECT name FROM users HAVING COUNT(*) > 1", "SELECT COALESCE(SUM(id), 0) AS total FROM users", "SELECT name FROM users UNION SELECT name FROM archived_users"])("keeps structural grouping and set queries read-only: %s", async (sql) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    const { analyzeEditableQueryEditability: analyzeSqlEditability } = await import("@/lib/sql/sqlAnalysis");
    analyzeEditableQueryEditability.mockImplementation(async (query: string) => analyzeSqlEditability(query));
    executeMulti.mockResolvedValue([{ columns: ["name"], rows: [["Alice"]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, sql);
    expect(executeMulti).toHaveBeenLastCalledWith("oracle-1", "ORCL", sql, undefined, expect.any(String), expect.any(Object));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe(sql.includes("UNION") ? "set-operation" : "aggregation"));
    expect(tab.queryAnalysis).toBeUndefined();
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
  });

  it("never rewrites an Oracle GROUP BY query with hidden ROWID", async () => {
    getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
      query_timeout_secs: 30,
    });
    getColumns.mockResolvedValue([
      { name: "P_ID", type_name: "VARCHAR2", nullable: true },
      { name: "SUBJECT", type_name: "VARCHAR2", nullable: true },
      { name: "CREATE_TIME", type_name: "DATE", nullable: true },
    ]);
    listTables.mockResolvedValue([{ name: "RECORD", table_type: "TABLE" }]);
    listIndexes.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: false,
      reason: "aggregation",
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["P_ID", "SUBJECT", "CNT_NUM"],
        rows: [["123214512", "邮件提醒", 1]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    const sql = `SELECT 
  R.P_ID, 
  R.SUBJECT, 
  COUNT(0) AS CNT_NUM
  FROM COMMON.RECORD R
 WHERE R.CREATE_TIME >= SYSDATE - INTERVAL '1' DAY
   AND R.SUBJECT = '邮件提醒'
   AND R.P_ID = '123214512'
 GROUP BY R.P_ID, R.SUBJECT`;

    // Execute first time (populates metadata cache)
    await store.executeTabSql(tabId, sql);
    expect(executeMulti).toHaveBeenLastCalledWith("oracle-1", "ORCL", sql, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));

    // Execute second time (cache hit within 30s)
    await store.executeTabSql(tabId, sql);
    expect(executeMulti).toHaveBeenLastCalledWith("oracle-1", "ORCL", sql, undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    expect(executeMulti).not.toHaveBeenCalledWith("oracle-1", "ORCL", expect.stringContaining("ROWIDTOCHAR"), undefined, expect.any(String), expect.any(Object));

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
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

  it("uses a qualified Oracle ROWID from a joined query as the synthetic row key", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, tableName: string) =>
      tableName === "USERS"
        ? [
            { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
            { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
          ]
        : [{ name: "LABEL", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
    );
    lookupLocalCompletionTables.mockReturnValue([
      { name: "USERS", type: "table", schema: "APP" },
      { name: "ORDERS", type: "table", schema: "APP" },
    ]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "USERS",
        selectStar: false,
        sources: [
          { key: "t:0", schema: "APP", tableName: "USERS", alias: "t" },
          { key: "o:1", schema: "APP", tableName: "ORDERS", alias: "o" },
        ],
        columns: [
          { sourceName: "ROWID", sourceQualifier: "t", sourceKey: "t:0", resultName: "ROWID", expression: "t.ROWID" },
          { sourceName: "NAME", sourceQualifier: "t", sourceKey: "t:0", resultName: "NAME", expression: "t.NAME" },
          { sourceName: "LABEL", sourceQualifier: "o", sourceKey: "o:1", resultName: "LABEL", expression: "o.LABEL" },
        ],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ROWID", "NAME", "LABEL"],
        rows: [["AAAPr9AAEAAAACXAAA", "Alice", "Order"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT t.ROWID, t.NAME, o.LABEL FROM APP.USERS t LEFT JOIN APP.ORDERS o ON o.USER_ID = t.ID");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.result?.columns).toEqual(["ROWID", "NAME", "LABEL"]));
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["__DBX_ROWID", "NAME", undefined]), { timeout: 5000 });
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
    expect(tab.queryAnalysis).toBeDefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  }, 10_000);

  it.each([
    {
      connection: { id: "oracle-1", name: "Oracle", db_type: "oracle", database: "XE", query_timeout_secs: 30 },
      label: "native Oracle",
    },
    {
      connection: { id: "oracle-jdbc-1", name: "Oracle JDBC", db_type: "jdbc", connection_string: "jdbc:oracle:thin:@//localhost:1521/XE", database: "XE", query_timeout_secs: 30 },
      label: "Oracle-inferred JDBC",
    },
  ])("edits an unqualified lowercase query through the folded current-schema table for $label", async ({ connection }) => {
    getConnectionConfig.mockReturnValue(connection);
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "imp_t",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ID", "NAME"], rows: [[1, "Alice"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab(connection.id, "XE", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "select * from imp_t");

    // The service name must not leak into the metadata schema, and the stored
    // table spelling has to fold to uppercase so the generated UPDATE quotes
    // the object Oracle actually resolved for the unqualified SELECT.
    expect(getColumns).toHaveBeenCalledWith(connection.id, "XE", "", "IMP_T", undefined);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("IMP_T"));
    expect(tab.tableMeta?.schema).toBeUndefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it("keeps an unqualified lowercase MySQL JDBC query on its unfolded table name", async () => {
    getConnectionConfig.mockReturnValue({ id: "jdbc-mysql-1", name: "MySQL JDBC", db_type: "jdbc", connection_string: "jdbc:mysql://localhost:3306/app", database: "app", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar(64)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["id", "name"], rows: [[1, "Alice"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-mysql-1", "app", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "select * from users");

    expect(getColumns).toHaveBeenCalledWith("jdbc-mysql-1", "app", "", "users", undefined);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("users"));
    expect(tab.tableMeta?.schema).toBeUndefined();
    expect(tab.queryEditabilityReason).toBeUndefined();
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

  it("executes an unqualified Oracle query without enumerating objects when its type is unknown", async () => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listTables.mockReturnValue(new Promise(() => undefined));
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "CUSTOMER_VIEW",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["ID", "NAME"],
        rows: [[1, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    const execution = store.executeTabSql(tabId, "SELECT * FROM CUSTOMER_VIEW");
    await vi.waitFor(() => expect(executeMulti).toHaveBeenCalled(), { timeout: 250 });
    await execution;

    expect(listTables).not.toHaveBeenCalled();
    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM CUSTOMER_VIEW", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("no-primary-key"));
    expect(tab.queryAnalysis).toBeUndefined();
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

  it.each([
    ["oracle", true],
    ["oracle", false],
    ["xugu", true],
    ["xugu", false],
  ] as const)("starts a %s query (star=%s) when synonym columns are slow and indexes return no key", async (databaseType, selectStar) => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    getConnectionConfig.mockReturnValue({ id: "synonym-1", name: "Synonym", db_type: databaseType, database: "APP", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    listIndexes.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockImplementation(async () => ({
      editable: true,
      analysis: {
        schema: "APP",
        tableName: "ORDERS_ALIAS",
        selectStar,
        columns: selectStar ? [] : [{ sourceName: "NAME", resultName: "NAME" }],
      },
    }));
    executeMulti.mockResolvedValue([
      {
        columns: selectStar ? ["ID", "NAME"] : ["NAME"],
        rows: selectStar ? [[1, "Alice"]] : [["Alice"]],
        affected_rows: 0,
        execution_time_ms: 18,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("synonym-1", "APP", "Query");
    store.setAutoCommit(tabId, true);
    vi.useFakeTimers();
    const sql = `SELECT ${selectStar ? "*" : "NAME"} FROM APP.ORDERS_ALIAS`;
    const execution = store.executeTabSql(tabId, sql);
    try {
      await vi.waitFor(() => expect(getColumns).toHaveBeenCalledOnce());
      expect(executeMulti).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(executeMulti).toHaveBeenCalledOnce();
      expect(executeMulti.mock.calls[0]?.[2]).toBe(sql);
      await execution;
      expect(store.tabs.find((tab) => tab.id === tabId)?.result?.rows).toEqual(selectStar ? [[1, "Alice"]] : [["Alice"]]);

      columnsGate.resolve([
        { name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "NAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ]);
      const { getCachedTableMetadata } = await import("@/lib/metadata/tableMetadataCache");
      await vi.waitFor(() => expect(getCachedTableMetadata({ connectionId: "synonym-1", database: "APP", schema: "APP", tableName: "ORDERS_ALIAS", databaseType })?.metadata.columns).toHaveLength(2));
      expect(getColumns).toHaveBeenCalledOnce();
      expect(listIndexes).toHaveBeenCalledOnce();
    } finally {
      columnsGate.resolve([]);
      await execution;
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares one Oracle preflight deadline between slow indexes and pending columns", async () => {
    const columnsGate = deferred<Awaited<ReturnType<typeof getColumns>>>();
    const indexesGate = deferred<Awaited<ReturnType<typeof listIndexes>>>();
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "APP", query_timeout_secs: 30 });
    getColumns.mockReturnValue(columnsGate.promise);
    listIndexes.mockReturnValue(indexesGate.promise);
    analyzeEditableQueryEditability.mockImplementation(async () => ({ editable: true, analysis: { schema: "APP", tableName: "ORDERS_ALIAS", selectStar: true, columns: [] } }));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "APP", "Query");
    store.setAutoCommit(tabId, true);
    vi.useFakeTimers();
    const execution = store.executeTabSql(tabId, "SELECT * FROM APP.ORDERS_ALIAS");
    try {
      await vi.waitFor(() => expect(listIndexes).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(500);
      indexesGate.resolve([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(executeMulti).toHaveBeenCalledOnce();
      await execution;
    } finally {
      indexesGate.resolve([]);
      columnsGate.resolve([]);
      await execution;
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
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

  it.each(["oracle", "oceanbase-oracle"])("continues the %s cursor for page 2 in a manual transaction", async (databaseType) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: databaseType, database: "ORCL", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: databaseType === "oceanbase-oracle" ? undefined : options.sql,
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

  it("advances an Elasticsearch cursor without replacing the displayed page", async () => {
    getConnectionConfig.mockReturnValue({ id: "elasticsearch-1", name: "Elasticsearch", db_type: "elasticsearch", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: true,
    }));
    executeMulti
      .mockResolvedValueOnce([
        {
          columns: ["message"],
          rows: [["page-1"]],
          affected_rows: 20_000,
          execution_time_ms: 1,
          session_id: "cursor-1",
          has_more: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          columns: ["message"],
          rows: [["page-2"]],
          affected_rows: 20_000,
          execution_time_ms: 1,
          session_id: "cursor-2",
          has_more: true,
        },
      ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("elasticsearch-1", "", "Query");
    const sql = "SELECT * FROM `dbx-app-logs-v1` AS dalv";

    await store.executeTabSql(tabId, sql, { pagination: { limit: 100, offset: 0 } });
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const displayedResult = tab.result;

    await store.executeTabSql(tabId, sql, {
      resultBaseSql: sql,
      pagination: { limit: 100, offset: 100, sessionId: "cursor-1", clientSessionId: tab.resultClientSessionId },
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
      retainDisplayedResult: true,
    });

    expect(tab.result).toBe(displayedResult);
    expect(tab.result?.rows).toEqual([["page-1"]]);
    expect(tab.resultPageOffset).toBe(0);
    expect(tab.resultSessionId).toBe("cursor-2");
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

    // MySQL is a sticky proven-read-only dialect (#9018): the call now ends
    // with the user-facing classification SQL (9th argument), but still opts
    // out of table-data preview. Every slot stays asserted — the spec's mocks
    // are fixed, so database/schema/row-limit/cursor args must not drift.
    expect(executeInManualTransaction).toHaveBeenCalledWith("txn-1", "SELECT name, `id` AS `__DBX_PK_0` FROM users", "app", undefined, 100000, false, undefined, undefined, "SELECT name FROM users");
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

  it.each([
    { sourceSchema: undefined, synonym: true },
    { sourceSchema: "ExplicitOwner", synonym: true },
    { sourceSchema: undefined, synonym: false },
  ])("keeps OceanBase current schema separate from explicit source schema $sourceSchema with synonym=$synonym", async ({ sourceSchema, synonym }) => {
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "service", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([{ name: "ItemId", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: true, extra: null, ...(synonym ? { resolved_schema: "TargetOwner", resolved_table: "Items", resolved_object_type: "TABLE" } : {}) }]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: sourceSchema,
        schemaQuoted: true,
        tableName: "ItemsAlias",
        tableNameQuoted: true,
        selectStar: false,
        columns: [{ sourceName: "ItemId", sourceNameQuoted: true, resultName: "ItemId", expression: '"ItemId"' }],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["ItemId"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "service", "Query", "query", "SelectedOwner");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, sourceSchema ? 'SELECT "ItemId" FROM "ExplicitOwner"."ItemsAlias"' : 'SELECT "ItemId" FROM "ItemsAlias"');

    if (sourceSchema) expect(getColumns).toHaveBeenCalledWith("ob-1", "service", "ExplicitOwner", "ItemsAlias", undefined);
    else expect(getColumns).toHaveBeenCalledWith("ob-1", "service", "", "ItemsAlias", undefined, undefined, "SelectedOwner");
    expect(listIndexes).toHaveBeenCalledWith("ob-1", "service", synonym ? "TargetOwner" : "SelectedOwner", synonym ? "Items" : "ItemsAlias", undefined);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toMatchObject({ schema: synonym ? "TargetOwner" : "SelectedOwner", tableName: synonym ? "Items" : "ItemsAlias" }));
    if (synonym) expect(tab.tableMeta?.tableType).toBe("TABLE");
    expect(tab.queryAnalysis?.tableName).toBe("ItemsAlias");
  });

  it.each(["VIEW", undefined])("does not treat a synonym target of type %s as an Oracle base table", async (objectType) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    getColumns.mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_nullable: false, column_default: null, is_primary_key: false, extra: null, resolved_schema: "TargetOwner", resolved_table: "ActualItems", resolved_object_type: objectType }]);
    lookupLocalCompletionTables.mockReturnValue([{ name: "ITEMS_ALIAS", type: "table", schema: "APP" }]);
    analyzeEditableQueryEditability.mockResolvedValue({ editable: true, analysis: { schema: "APP", tableName: "ITEMS_ALIAS", selectStar: true, columns: [] } });
    executeMulti.mockResolvedValue([{ columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "SELECT * FROM APP.ITEMS_ALIAS");

    expect(executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT * FROM APP.ITEMS_ALIAS", undefined, expect.any(String), expect.any(Object));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.result?.columns).toEqual(["ID"]));
    expect(tab.result?.hidden_column_indexes).toBeUndefined();
    expect(tab.queryAnalysis).toBeUndefined();
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

  it("defers DB2 BLOB materialization for a non-null unique-index star query", async () => {
    getConnectionConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", database: "MAXIMO", query_timeout_secs: 60 });
    getColumns.mockResolvedValue([
      { name: "MAFAPPDATAID", data_type: "BIGINT", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "APP", data_type: "BLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([{ name: "MAFAPPDATA_UQ", columns: ["MAFAPPDATAID"], is_unique: true, is_primary: false }]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "MAFAPPDATA",
        tableAlias: "mf",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["MAFAPPDATAID", "APP"],
        rows: [[1, "<BLOB>"]],
        affected_rows: 0,
        execution_time_ms: 57,
        large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }],
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("db2-1", "MAXIMO", "Query", "query", "MAXIMO");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "select * from MAFAPPDATA mf");

    expect(executeMulti).toHaveBeenCalledWith("db2-1", "MAXIMO", "select * from MAFAPPDATA mf", "MAXIMO", expect.any(String), expect.objectContaining({ tableDataPreview: true, timeoutSecs: 60 }));
    expect(store.tabs.find((tab) => tab.id === tabId)?.result?.large_value_cells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }]);
  });

  it("defers DB2 BLOB materialization through a persisted virtual unique key", async () => {
    getConnectionConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", database: "MAXIMO", query_timeout_secs: 60 });
    const columns = [
      { name: "MAFAPPDATAID", data_type: "BIGINT", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "APP", data_type: "BLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ];
    getColumns.mockResolvedValue(columns);
    listIndexes.mockResolvedValue([]);
    expect(saveVirtualRowIdentifier({ connectionId: "db2-1", database: "MAXIMO", schema: "MAXIMO", tableName: "MAFAPPDATA" }, ["MAFAPPDATAID"], columns)).toBe(true);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "MAFAPPDATA",
        tableAlias: "mf",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["MAFAPPDATAID", "APP"],
        rows: [[1, "<BLOB>"]],
        affected_rows: 0,
        execution_time_ms: 57,
        large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }],
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("db2-1", "MAXIMO", "Query", "query", "MAXIMO");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "select * from MAFAPPDATA mf");

    expect(executeMulti).toHaveBeenCalledWith("db2-1", "MAXIMO", "select * from MAFAPPDATA mf", "MAXIMO", expect.any(String), expect.objectContaining({ tableDataPreview: true, timeoutSecs: 60 }));
    await vi.waitFor(() => expect(store.tabs.find((tab) => tab.id === tabId)?.tableMeta?.virtualPrimaryKeys).toEqual(["MAFAPPDATAID"]));
  });

  it("keeps deferred DB2 LOB handling disabled without a stable key", async () => {
    getConnectionConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", database: "MAXIMO", query_timeout_secs: 60 });
    getColumns.mockResolvedValue([{ name: "APP", data_type: "BLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null }]);
    listIndexes.mockResolvedValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "MAFAPPDATA",
        tableAlias: "mf",
        selectStar: true,
        columns: [],
      },
    });
    executeMulti.mockResolvedValue([{ columns: ["APP"], rows: [["0x01"]], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("db2-1", "MAXIMO", "Query", "query", "MAXIMO");
    store.setAutoCommit(tabId, true);

    await store.executeTabSql(tabId, "select * from MAFAPPDATA mf");

    expect(executeMulti).toHaveBeenCalledOnce();
    expect(executeMulti.mock.calls[0]?.[5]).not.toHaveProperty("tableDataPreview");
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
      tieBreakerColumnIndexes: [1],
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

  it("injects a non-null unique index when the table has no declared primary key", async () => {
    getColumns.mockResolvedValue([
      { name: "email", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ]);
    listIndexes.mockResolvedValue([{ name: "uq_users_email", columns: ["email"], is_unique: true, is_primary: false }]);
    analyzeEditableQueryEditability.mockImplementation(async (sql: string) => ({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "users",
        selectStar: false,
        columns: [{ sourceName: "name", resultName: "name", expression: "name" }, ...(sql.includes("__DBX_PK_0") ? [{ sourceName: "email", resultName: "__DBX_PK_0", expression: "`email`" }] : [])],
      },
    }));
    executeMulti.mockResolvedValue([
      {
        columns: ["name", "__DBX_PK_0"],
        rows: [["Alice", "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT name FROM users");

    expect(executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT name, `email` AS `__DBX_PK_0` FROM users", undefined, expect.any(String), expect.objectContaining({ timeoutSecs: 30 }));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["name", "email"]));
    expect(tab.queryEditabilityReason).toBeUndefined();
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

  it.each([
    { manual: false, tailRows: 0 },
    { manual: false, tailRows: 1 },
    { manual: false, tailRows: 4 },
    { manual: true, tailRows: 0 },
    { manual: true, tailRows: 1 },
    { manual: true, tailRows: 4 },
  ])("accounts for appended rows once (manual=$manual, tail=$tailRows)", async ({ manual, tailRows }) => {
    editorSettings.queryResultMaxRows = 10;
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    const page = (offset: number, count: number) => ({ columns: ["id"], rows: Array.from({ length: count }, (_, index) => [offset + index]), has_more: false, affected_rows: 0, execution_time_ms: 1 });
    const execute = manual ? executeInManualTransaction : executeMulti;
    execute.mockResolvedValueOnce([page(0, 6)]).mockResolvedValueOnce([page(6, tailRows)]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    if (manual) {
      tab.autoCommit = false;
      tab.txnSessionId = "source-transaction";
    }
    await store.executeTabSql(id, "SELECT id FROM items", { pagination: { limit: 6, offset: 0 } });
    await store.executeTabSql(id, "SELECT id FROM items", {
      pagination: { limit: 4, offset: 6 },
      preserveResultDuringExecution: true,
      appendResult: { maxRows: 10 },
    });
    expect(tab.result?.rows).toHaveLength(6 + tailRows);
    expect(tab.result?.truncated === true).toBe(tailRows === 4);
    expect(tab.resultExecutedPageOffset).toBe(6);
    expect(tab.resultPageOffset).toBe(0);
    if (tailRows < 4) {
      expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual(tab.result?.rows);
      expect(execute).toHaveBeenCalledTimes(2);
    }
    if (manual) expect(tab.txnSessionId).toBe("source-transaction");
  });

  it("removes the generated row number before appending OceanBase Oracle pages", async () => {
    const sql = "SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 4";
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app" });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: false,
      paginationRowNumberColumn: options.pagination.offset > 0 ? "__dbx_row_num" : undefined,
    }));
    executeMulti.mockResolvedValueOnce([{ columns: ["N"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1 }]).mockResolvedValueOnce([
      {
        columns: ["N", "__dbx_row_num"],
        rows: [
          [3, 3],
          [4, 4],
        ],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "app", "Query");
    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 0 } });
    await store.executeTabSql(tabId, sql, {
      pagination: { limit: 2, offset: 2 },
      preserveResultDuringExecution: true,
      appendResult: { maxRows: 10 },
    });
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.columns).toEqual(["N"]);
    expect(tab.result?.rows).toEqual([[1], [2], [3], [4]]);

    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: options.sql,
      pageLimit: 2,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: false,
      paginationRowNumberColumn: options.pagination.offset > 0 ? "__dbx_row_num" : undefined,
    }));
    executeMulti
      .mockResolvedValueOnce([{ columns: ["N"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([
        {
          columns: ["N", "__dbx_row_num"],
          rows: [
            [3, 3],
            [4, 4],
          ],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      ])
      .mockResolvedValueOnce([{ columns: ["N", "__dbx_row_num"], rows: [], affected_rows: 0, execution_time_ms: 1 }]);
    const exported = await store.fetchTabResultForExport(tabId);
    expect(exported?.columns).toEqual(["N"]);
    expect(exported?.rows).toEqual([[1], [2], [3], [4]]);
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
      database: "app",
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
        database: "app",
        schema: "public",
        tableName: "users",
        whereInput: undefined,
        countHint: expectedCountHint,
      }),
    );
  });

  it.each([
    ["disabled by default", undefined, undefined],
    ["explicitly enabled", { gaussdbCountQueryDop: 8 }, "/*+ set(query_dop 8) */"],
  ])("passes the GaussDB query_dop hint to query-result count and page planning %s", async (_label, externalConfig, expectedHint) => {
    getConnectionConfig.mockReturnValue({
      id: "gaussdb-1",
      name: "GaussDB",
      db_type: "gaussdb",
      database: "app",
      query_timeout_secs: 30,
      external_config: externalConfig,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("gaussdb-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT id, name FROM users", {
      pagination: { limit: 100, offset: 0 },
    });

    expect(prepareQueryPaginationExecutionPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "gaussdb",
        queryBaseSql: "SELECT id, name FROM users",
        executionHint: expectedHint,
      }),
    );
  });

  it.each([
    [true, 100_000],
    [false, 100_000],
    [true, 2455],
    [false, 2455],
  ] as const)("keeps Oracle last-page and previous-page rows correct with autoCommit=%s, maxRows=%s (#13173)", async (autoCommit, maxRows) => {
    editorSettings.queryResultMaxRows = maxRows;
    getConnectionConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "XE", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      useAgentResultSession: true,
    }));
    const rows = Array.from({ length: 2473 }, (_, index) => [index + 1]);
    const total = Math.min(rows.length, maxRows);
    let position = 0;
    const readPage = (maxRows: number, pageSize?: number, sessionId?: string) => {
      if (!sessionId) position = 0;
      const pageRows = rows.slice(position, Math.min(position + (pageSize ?? maxRows), maxRows));
      position += pageRows.length;
      const hasMore = !!pageSize && position < Math.min(rows.length, maxRows);
      return [{ columns: ["ID"], rows: pageRows, affected_rows: 0, execution_time_ms: 1, has_more: hasMore, session_id: hasMore ? "oracle-cursor" : undefined, manual_transaction_proven_read_only: sessionId ? undefined : true }];
    };
    executeMulti.mockImplementation(async (_connection, _database, _sql, _schema, _execution, options) => readPage(options.maxRows, options.pageSize, options.resultSessionId));
    executeInManualTransaction.mockImplementation(async (_txn, _sql, _database, _schema, maxRows, _preview, pageSize, sessionId) => readPage(maxRows, pageSize, sessionId));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "XE", "Query");
    store.setAutoCommit(tabId, autoCommit);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const sql = "WITH a AS (SELECT id FROM events) SELECT a.* FROM a ORDER BY id";
    const loadPage = (offset: number, sessionId?: string) =>
      store.executeTabSql(tabId, sql, {
        pagination: { limit: 200, offset, sessionId },
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
      });
    await loadPage(0);
    expect(tab.result?.rows).toEqual(rows.slice(0, 200));
    await loadPage(200, tab.resultSessionId);
    expect(tab.result?.rows).toEqual(rows.slice(200, 400));
    tab.resultTotalRowCount = 2473;

    await loadPage(2400);
    expect(tab.result?.rows).toEqual(rows.slice(2400, total));
    expect(tab.resultPageOffset).toBe(2400);
    expect(tab.resultTotalRowCount).toBe(total);
    expect(tab.result?.has_more).toBe(false);

    await loadPage(2200);
    expect(tab.result?.rows).toEqual(rows.slice(2200, 2400));
    expect(tab.resultPageOffset).toBe(2200);
    expect(tab.result?.has_more).toBe(true);
    if (!autoCommit) expect(tab.result?.manual_transaction_session_id).toBe("txn-1");
    await loadPage(2400, tab.resultSessionId);
    expect(tab.result?.rows).toEqual(rows.slice(2400, total));
    expect(tab.resultTotalRowCount).toBe(total);
    expect(tab.autoCommit).toBe(autoCommit);
    if (!autoCommit) {
      expect(executeMulti).not.toHaveBeenCalled();
      expect(beginManualTransaction).toHaveBeenCalledTimes(1);
      expect(executeInManualTransaction.mock.calls.every((call) => call[0] === "txn-1")).toBe(true);
      expect(executeInManualTransaction.mock.calls.every((call) => call[4] === maxRows)).toBe(true);
      expect(tab.txnPossiblyDirty).not.toBe(true);
    }
  });

  it.each(["fetch error", "missing cursor"])("closes the manual replay cursor after a %s without switching connections", async (failure) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", db_type: "oracle", database: "XE" });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false });
    prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT * FROM events", pageLimit: 2, pageOffset: 4, useAgentResultSession: true });
    executeInManualTransaction.mockResolvedValueOnce([{ columns: ["ID"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, has_more: true, session_id: "cursor-1", manual_transaction_proven_read_only: true }]);
    if (failure === "fetch error") executeInManualTransaction.mockRejectedValueOnce(new Error("Cursor fetch failed"));
    else executeInManualTransaction.mockResolvedValueOnce([{ columns: ["ID"], rows: [], affected_rows: 0, execution_time_ms: 1, has_more: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "XE", "Query");
    store.setAutoCommit(id, false);

    await store.executeTabSql(id, "SELECT * FROM events", { pagination: { limit: 2, offset: 4 } });

    expect(executeInManualTransaction).toHaveBeenCalledTimes(2);
    expect(closeQuerySession).toHaveBeenCalledWith("oracle-1", "XE", "cursor-1", undefined, undefined, "txn-1");
    expect(executeMulti).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === id)?.result?.execution_error).toBe(true);
  });

  it.each([
    [1, "cancel"],
    [3, "cancel"],
    [3, "supersede"],
  ] as const)("closes the returned manual cursor when page %s is interrupted by %s", async (interruptAt, interruption) => {
    getConnectionConfig.mockReturnValue({ id: "oracle-1", db_type: "oracle", database: "XE" });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false });
    prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT * FROM events", pageLimit: 2, pageOffset: 4, useAgentResultSession: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "XE", "Query");
    store.setAutoCommit(id, false);
    const tab = store.tabs.find((item) => item.id === id)!;
    let calls = 0;
    executeInManualTransaction.mockImplementation(async () => {
      calls += 1;
      if (calls === interruptAt) {
        if (interruption === "cancel") tab.cancelRequestCount = (tab.cancelRequestCount ?? 0) + 1;
        else tab.executionId = "replacement-execution";
      }
      return [{ columns: ["ID"], rows: [[calls * 2 - 1], [calls * 2]], affected_rows: 0, execution_time_ms: 1, has_more: true, session_id: `cursor-${calls}`, manual_transaction_proven_read_only: calls === 1 ? true : undefined }];
    });

    await store.executeTabSql(id, "SELECT * FROM events", { pagination: { limit: 2, offset: 4 } });

    expect(executeInManualTransaction).toHaveBeenCalledTimes(interruptAt);
    expect(closeQuerySession).toHaveBeenCalledWith("oracle-1", "XE", `cursor-${interruptAt}`, undefined, undefined, "txn-1");
    expect(executeMulti).not.toHaveBeenCalled();
    expect(tab.result?.rows).not.toEqual([[5], [6]]);
  });

  it("closes retained manual cursors by their original transaction even when their IDs match", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "XE", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.txnSessionId = "newest-txn";
    const result = (owner: string) => ({ columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-1", manual_transaction_session_id: owner });
    tab.result = result("txn-current-result");
    tab.resultSessionId = "cursor-1";
    tab.resultClientSessionId = id;
    tab.resultRuns = [{ id: "old-run", title: "Old result", sequence: 1, sql: "SELECT * FROM events", createdAt: 0, result: result("txn-old-result"), resultSessionId: "cursor-1", resultClientSessionId: id }];

    await store.clearQueryResults(id);

    expect(closeQuerySession.mock.calls).toEqual([
      ["oracle-1", "XE", "cursor-1", undefined, undefined, "txn-current-result"],
      ["oracle-1", "XE", "cursor-1", undefined, undefined, "txn-old-result"],
    ]);
    expect(closeClientConnectionSession).not.toHaveBeenCalled();
    expect(tab.txnSessionId).toBe("newest-txn");
  });

  it("does not clear a replacement cursor while the old transaction's close is pending", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "XE", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.result = { columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-1", manual_transaction_session_id: "old-txn" };
    tab.resultSessionId = "cursor-1";
    const pendingClose = deferred<boolean>();
    closeQuerySession.mockReturnValueOnce(pendingClose.promise);
    const clearing = store.clearQueryResults(id);
    tab.result = { columns: ["ID"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-1", manual_transaction_session_id: "new-txn" };
    tab.resultSessionId = "cursor-1";
    tab.resultClientSessionId = id;
    pendingClose.resolve(true);
    await clearing;

    expect(tab.resultSessionId).toBe("cursor-1");
    expect(tab.resultClientSessionId).toBe(id);
    expect(tab.result.manual_transaction_session_id).toBe("new-txn");
    expect(tab.result.session_id).toBe("cursor-1");
    expect(closeQuerySession).toHaveBeenCalledWith("oracle-1", "XE", "cursor-1", undefined, undefined, "old-txn");
  });

  it("advances an OceanBase duplicate projection cursor through an offset jump and next page", async () => {
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: true,
    }));
    let row = 0;
    executeMulti.mockImplementation(async () => [
      {
        columns: ["NAME", "NAME"],
        rows: Array.from({ length: 2 }, () => [++row, row]),
        affected_rows: 0,
        execution_time_ms: 1,
        session_id: "ob-cursor",
        has_more: row < 8,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "app", "Query");
    const sql = "SELECT a.name, a.* FROM people a ORDER BY a.id";
    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 4 } });
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.rows).toEqual([
      [5, 5],
      [6, 6],
    ]);
    expect(executeMulti).toHaveBeenCalledTimes(3);
    expect(executeMulti.mock.calls[0]![5]).toEqual(expect.objectContaining({ pageSize: 2, fetchSize: 2, resultSessionId: undefined }));
    expect(executeMulti.mock.calls[0]![5].maxRows).toBeGreaterThan(2);
    expect(executeMulti.mock.calls[1]![5].resultSessionId).toBe("ob-cursor");
    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 6, sessionId: "ob-cursor" } });
    expect(executeMulti).toHaveBeenCalledTimes(4);
    expect(executeMulti.mock.calls[3]![2]).toBe(sql);
    expect(tab.result?.rows).toEqual([
      [7, 7],
      [8, 8],
    ]);
    expect(tab.result?.columns).toEqual(["NAME", "NAME"]);
  });

  it.each(["SELECT * FROM events", "SELECT t.* FROM events t"])("preserves a real __dbx_row_num column across OceanBase wildcard pages: %s", async (sql) => {
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      useAgentResultSession: true,
    }));
    let row = 0;
    executeMulti.mockImplementation(async () => [
      {
        columns: ["ID", "__dbx_row_num"],
        rows: Array.from({ length: 2 }, () => [++row, `user-${row}`]),
        affected_rows: 0,
        execution_time_ms: 1,
        session_id: "ob-star-cursor",
        has_more: row < 6,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "app", "Query");
    for (const offset of [0, 2, 4]) {
      await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset, sessionId: offset ? "ob-star-cursor" : undefined } });
      const result = store.tabs.find((item) => item.id === tabId)!.result;
      expect(result?.columns).toEqual(["ID", "__dbx_row_num"]);
      expect(result?.rows).toEqual([
        [offset + 1, `user-${offset + 1}`],
        [offset + 2, `user-${offset + 2}`],
      ]);
    }
    expect(executeMulti).toHaveBeenCalledTimes(3);
    for (const [index, call] of executeMulti.mock.calls.entries()) {
      expect(call[2]).toBe(sql);
      expect(call[5]).toEqual(expect.objectContaining({ pageSize: 2, fetchSize: 2, resultSessionId: index ? "ob-star-cursor" : undefined }));
    }
  });

  it("does not execute an OceanBase offset plan rejected without a cursor", async () => {
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async () => ({
      sqlToExecute: "",
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
      paginationError: "This query requires an Agent result session for offset pagination",
    }));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "app", "Query");
    await store.executeTabSql(tabId, "SELECT name, name FROM people", { pagination: { limit: 2, offset: 4 } });
    expect(store.tabs.find((item) => item.id === tabId)?.result?.execution_error).toBe(true);
    expect(executeMulti).not.toHaveBeenCalled();
    expect(executeInManualTransaction).not.toHaveBeenCalled();
  });

  it("rejects a fresh OceanBase manual-transaction offset instead of repeating the first page", async () => {
    getConnectionConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app", query_timeout_secs: 30 });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "complex-query" });
    prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: options.pagination.limit,
      pageOffset: options.pagination.offset,
      countSql: undefined,
      useAgentResultSession: true,
    }));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "app", "Query");
    store.setAutoCommit(tabId, false);
    await store.executeTabSql(tabId, "SELECT name, name FROM people", { pagination: { limit: 2, offset: 4 } });
    expect(store.tabs.find((item) => item.id === tabId)?.result?.execution_error).toBe(true);
    expect(executeMulti).not.toHaveBeenCalled();
    expect(executeInManualTransaction).not.toHaveBeenCalled();
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
