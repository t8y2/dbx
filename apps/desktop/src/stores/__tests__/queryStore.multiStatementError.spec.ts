import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  executeQuery: vi.fn(),
  getConnectionConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
  tabResultSnapshots: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  executeQuery: mocks.executeQuery,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { autoCalculateTotalRows: false, pageSize: 100, continueOnErrorOnBatch: false },
  }),
}));

vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
  return {
    ...actual,
    writeTabResultSnapshot: vi.fn(async (key: string, snapshot: unknown) => {
      mocks.tabResultSnapshots.set(key, actual.decodeTabResultSnapshot(actual.encodeTabResultSnapshot(snapshot as Parameters<typeof actual.encodeTabResultSnapshot>[0])));
      return true;
    }),
    readTabResultSnapshot: vi.fn(async (key: string) => mocks.tabResultSnapshots.get(key)),
    deleteTabResultSnapshot: vi.fn(async (key: string) => {
      mocks.tabResultSnapshots.delete(key);
    }),
  };
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function structuredTimeoutError() {
  return {
    version: 1 as const,
    code: "DBX-JDBC-2002",
    messageKey: "backendErrors.jdbc.operationTimedOut",
    messageParams: { stage: "execute" },
    source: "jdbcAgent" as const,
    operationOutcome: "unknown" as const,
  };
}

describe("queryStore multi-statement errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.tabResultSnapshots.clear();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
    mocks.executeMultiWithProgress.mockImplementation(async (connectionId, database, sql, onProgress, schema, options) => {
      const results = await mocks.executeMulti(connectionId, database, sql, schema, options?.executionId, options);
      const total = results.length;
      results.forEach((result: any, index: number) => {
        const statementIndex = result.statement_index ?? index;
        const success = result.execution_error !== true;
        onProgress({
          executionId: options?.executionId,
          statementIndex,
          completed: index + 1,
          total,
          success,
          executionTimeMs: result.execution_time_ms,
          affectedRows: result.affected_rows,
          error: success ? undefined : result.error,
        });
      });
      return results;
    });
  });

  it("opens the first error result from a mixed result batch", async () => {
    const structuredError = structuredTimeoutError();
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], execution_error: true, error: structuredError, rows: [["no such table: missing"]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT * FROM missing");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.result?.columns).toEqual(["Error"]);
    expect(tab.result?.error).toEqual(structuredError);
    expect(tab.batchSqlExecution?.items[1]?.errorDetails).toEqual(structuredError);
    expect(tab.batchSqlExecution?.items[1]?.error).not.toBe(structuredError.code);
    expect(tab.batchSqlExecution?.items[1]?.error).not.toBe("[object Object]");
  });

  it("updates live per-statement progress before the batch promise resolves", async () => {
    const pendingExecution = deferred<any[]>();
    let reportProgress!: (progress: any) => void;
    mocks.executeMultiWithProgress.mockImplementationOnce((_connectionId, _database, _sql, onProgress) => {
      reportProgress = onProgress;
      return pendingExecution.promise;
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, "SELECT 1;\nSELECT 2;\nSELECT bad");

    const execution = store.executeTabSql(tabId, "SELECT 1;\nSELECT 2;\nSELECT bad");
    await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution?.items[0]?.status).toBe("running"));
    const executionId = store.tabs.find((item) => item.id === tabId)!.executionId!;

    reportProgress({
      executionId,
      statementIndex: 0,
      completed: 1,
      total: 3,
      success: true,
      executionTimeMs: 4,
      affectedRows: 1,
    });

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution).toMatchObject({
      completed: 1,
      total: 3,
      items: [{ status: "success", executionTimeMs: 4, affectedRows: 1 }, { status: "running" }, { status: "pending" }],
    });

    pendingExecution.resolve([
      { columns: [], rows: [], affected_rows: 1, execution_time_ms: 4, statement_index: 0 },
      { columns: ["Error"], rows: [["bad statement"]], affected_rows: 0, execution_time_ms: 2, statement_index: 1, execution_error: true },
    ]);
    await execution;

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution).toMatchObject({
      completed: 2,
      items: [{ status: "success" }, { status: "error", error: "bad statement" }, { status: "skipped" }],
    });
  });

  it("records a top-level batch failure on the current statement", async () => {
    mocks.executeMultiWithProgress.mockRejectedValueOnce(new Error("transport failed"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, "SELECT 1;\nSELECT 2");

    await store.executeTabSql(tabId, "SELECT 1;\nSELECT 2");

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution).toMatchObject({
      completed: 1,
      items: [{ status: "error", error: "transport failed" }, { status: "skipped" }],
    });
  });

  it("preserves a structured top-level batch failure", async () => {
    const structuredError = structuredTimeoutError();
    mocks.executeMultiWithProgress.mockRejectedValueOnce(structuredError);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, "SELECT 1;\nSELECT 2");

    await store.executeTabSql(tabId, "SELECT 1;\nSELECT 2");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.error).toEqual(structuredError);
    expect(tab.result?.rows[0]?.[0]).toEqual(expect.any(String));
    expect(tab.result?.rows[0]?.[0]).not.toBe(structuredError.code);
    expect(tab.result?.rows[0]?.[0]).not.toBe("[object Object]");
    expect(tab.batchSqlExecution?.items[0]?.errorDetails).toEqual(structuredError);
    expect(tab.batchSqlExecution?.items[0]?.error).toBe(tab.result?.rows[0]?.[0]);
  });

  it("keeps completed progress and records a later top-level batch failure", async () => {
    mocks.executeMultiWithProgress.mockImplementationOnce((_connectionId, _database, _sql, onProgress, _schema, options) => {
      onProgress({
        executionId: options?.executionId,
        statementIndex: 0,
        completed: 1,
        total: 3,
        success: true,
        executionTimeMs: 4,
        affectedRows: 1,
      });
      return Promise.reject(new Error("connection lost"));
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, "SELECT 1;\nSELECT 2;\nSELECT 3");

    await store.executeTabSql(tabId, "SELECT 1;\nSELECT 2;\nSELECT 3");

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution).toMatchObject({
      completed: 2,
      items: [{ status: "success" }, { status: "error", error: "connection lost" }, { status: "skipped" }],
    });
  });

  it("updates the live marker state for a single statement", async () => {
    const pendingExecution = deferred<any[]>();
    mocks.executeMulti.mockImplementationOnce(() => pendingExecution.promise);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const sql = "SELECT 1";
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, sql);

    const execution = store.executeTabSql(tabId, sql);
    await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution?.items[0]?.status).toBe("running"));
    expect(mocks.executeMultiWithProgress).not.toHaveBeenCalled();

    pendingExecution.resolve([{ columns: ["Error"], rows: [["bad statement"]], affected_rows: 0, execution_time_ms: 3, statement_index: 0, execution_error: true }]);
    await execution;

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution).toMatchObject({
      completed: 1,
      total: 1,
      items: [{ status: "error", executionTimeMs: 3, affectedRows: 0, error: "bad statement" }],
    });
  });

  it("marks the active statement cancelled and leaves later statements unexecuted", async () => {
    const pendingExecution = deferred<never>();
    mocks.executeMultiWithProgress.mockImplementationOnce(() => pendingExecution.promise);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", undefined, "SELECT 1;\nSELECT 2");

    const execution = store.executeTabSql(tabId, "SELECT 1;\nSELECT 2");
    await vi.waitFor(() => expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution?.items[0]?.status).toBe("running"));
    await expect(store.cancelTabExecution(tabId)).resolves.toBe(true);
    pendingExecution.reject(new Error("Query canceled"));
    await execution;

    expect(store.tabs.find((item) => item.id === tabId)?.batchSqlExecution?.items).toMatchObject([{ status: "cancelled" }, { status: "skipped" }]);
  });

  it("opens a later PostgreSQL error result from a mixed result batch", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "postgres-1",
      name: "PostgreSQL",
      db_type: "postgres",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValue([
      { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index: 0 },
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["Error"], execution_error: true, rows: [["relation missing_table does not exist"]], affected_rows: 0, execution_time_ms: 1, statement_index: 2 },
      { columns: ["after_error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 3 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("postgres-1", "app", "Query");

    await store.executeTabSql(tabId, "BEGIN; SELECT 1 AS value; SELECT * FROM missing_table");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(2);
    expect(tab.result).toMatchObject({
      columns: ["Error"],
      execution_error: true,
      rows: [["relation missing_table does not exist"]],
    });
    expect(tab.results).toHaveLength(4);
  });

  it("invalidates only the executing Oracle tab after successful CURRENT_SCHEMA changes", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
      query_timeout_secs: 30,
    });
    mocks.executeMulti
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([{ columns: ["Error"], rows: [["schema missing"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }])
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabA = store.createTab("oracle-1", "ORCL", "Tab A");
    const tabB = store.createTab("oracle-1", "ORCL", "Tab B");

    await store.executeTabSql(tabA, "ALTER SESSION SET CURRENT_SCHEMA = REPORTING");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(1);
    expect(store.tabs.find((tab) => tab.id === tabB)?.completionContextVersion).toBeUndefined();

    await store.executeTabSql(tabA, "/* retry */ ALTER SESSION SET CURRENT_SCHEMA = MISSING");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(1);

    await store.executeTabSql(tabA, "-- switch back\nALTER SESSION SET CURRENT_SCHEMA = APP");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(2);
    expect(mocks.executeMulti.mock.calls.map((call) => call[5]?.clientSessionId)).toEqual([tabA, tabA, tabA]);
  });

  it("resolves the actual SAP HANA schema from the executing Agent session", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "hana-1",
      name: "SAP HANA",
      db_type: "saphana",
      database: "",
      query_timeout_secs: 30,
    });
    mocks.executeMulti
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([{ columns: ["Error"], rows: [["schema missing"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }])
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["CURRENT_SCHEMA"], rows: [["APP_SCHEMA"]], affected_rows: 0, execution_time_ms: 1 }).mockResolvedValueOnce({ columns: ["CURRENT_SCHEMA"], rows: [["MixedTargetSchema"]], affected_rows: 0, execution_time_ms: 1 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabA = store.createTab("hana-1", "", "Tab A");
    const tabB = store.createTab("hana-1", "", "Tab B");

    await store.executeTabSql(tabA, "SET SCHEMA app_schema_synonym");
    expect(store.tabs.find((tab) => tab.id === tabA)).toMatchObject({ schema: "APP_SCHEMA", completionContextVersion: 1 });
    expect(store.tabs.find((tab) => tab.id === tabB)?.schema).toBeUndefined();

    await store.executeTabSql(tabA, 'SET SCHEMA "MissingSchema"');
    expect(store.tabs.find((tab) => tab.id === tabA)).toMatchObject({ schema: "APP_SCHEMA", completionContextVersion: 1 });

    await store.executeTabSql(tabA, '/* switch */ SET SCHEMA "MixedSchema"');
    expect(store.tabs.find((tab) => tab.id === tabA)).toMatchObject({ schema: "MixedTargetSchema", completionContextVersion: 2 });
    expect(mocks.executeMulti.mock.calls.map((call) => call[5]?.clientSessionId)).toEqual([tabA, tabA, tabA]);
    expect(mocks.executeQuery.mock.calls.map((call) => ({ sql: call[2], schema: call[3], clientSessionId: call[5]?.clientSessionId }))).toEqual([
      { sql: "SELECT CURRENT_SCHEMA FROM DUMMY", schema: undefined, clientSessionId: tabA },
      { sql: "SELECT CURRENT_SCHEMA FROM DUMMY", schema: undefined, clientSessionId: tabA },
    ]);
  });

  it("syncs the executing SQL Server tab after a successful standalone USE", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "sqlserver-1",
      name: "SQL Server",
      db_type: "sqlserver",
      database: "FooDB",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]).mockResolvedValueOnce([{ columns: ["Error"], rows: [["Database does not exist"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabA = store.createTab("sqlserver-1", "FooDB", "Tab A", "query", "dbo");
    const tabB = store.createTab("sqlserver-1", "FooDB", "Tab B", "query", "dbo");

    await store.executeTabSql(tabA, "/* switch */ USE [BarDB];");

    expect(store.tabs.find((tab) => tab.id === tabA)).toMatchObject({ database: "BarDB", schema: undefined });
    expect(store.tabs.find((tab) => tab.id === tabB)).toMatchObject({ database: "FooDB", schema: "dbo" });
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("sqlserver-1", "FooDB", tabA);

    await store.executeTabSql(tabA, "USE [MissingDB];");

    expect(store.tabs.find((tab) => tab.id === tabA)?.database).toBe("BarDB");
  });

  it("invalidates Oracle completion metadata when clearing a tab schema resets its session", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Oracle", "query", "REPORTING");

    store.updateSchema(tabId, undefined);

    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      schema: undefined,
      completionContextVersion: 1,
    });
  });

  it("preserves the selected statement's absolute editor range", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const selectedSql = "SELECT * FROM users";

    await store.executeTabSql(tabId, selectedSql, { sourceOffset: 21 });

    expect(store.tabs.find((item) => item.id === tabId)?.result).toMatchObject({
      sourceStatement: selectedSql,
      sourceFrom: 21,
      sourceTo: 40,
    });
  });

  it("uses explicit statement indexes for selected multi-statement ranges", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["Error"], rows: [["failed"]], affected_rows: 0, execution_time_ms: 1, execution_error: true, statement_index: 2 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const selectedSql = "SELECT 1; SELECT 2; SELECT bad";

    await store.executeTabSql(tabId, selectedSql, { sourceOffset: 10 });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.results?.[0]).toMatchObject({
      sourceStatement: "SELECT 2",
      sourceFrom: 20,
      sourceTo: 28,
      statement_index: 1,
    });
    expect(tab.results?.[1]).toMatchObject({
      sourceStatement: "SELECT bad",
      sourceFrom: 30,
      sourceTo: 40,
      statement_index: 2,
      execution_error: true,
    });
  });

  it("maps SQL Server batch result sets by source order when statement indexes are unavailable", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "sqlserver-1",
      name: "SQL Server",
      db_type: "sqlserver",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValue([
      { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM users; SELECT * FROM orders");

    expect(store.tabs.find((item) => item.id === tabId)?.results).toMatchObject([
      { sourceStatement: "SELECT * FROM users", sourceLabel: "app.users" },
      { sourceStatement: "SELECT * FROM orders", sourceLabel: "app.orders" },
    ]);
  });

  it("uses Name comments for their indexed query results", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const sql = "-- Name: Users\nSELECT * FROM users;\n-- name : Orders\nSELECT * FROM orders";

    await store.executeTabSql(tabId, sql);

    expect(store.tabs.find((item) => item.id === tabId)?.results?.map((result) => result.sourceLabel)).toEqual(["Orders", "Users"]);
  });

  it("does not promote an unmarked Error alias without type metadata as a batch failure", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT 2 AS Error");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.result?.columns).toEqual(["value"]);
  });

  it("does not apply the MySQL result heuristic to a JDBC MySQL dialect", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "JDBC MySQL",
      db_type: "jdbc",
      connection_string: "jdbc:mysql://localhost:3306/app",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT 2 AS Error");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.result?.columns).toEqual(["value"]);
  });

  it("passes continueOnError=false from settings to executeMulti by default", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1");

    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT 1", undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
  });
  it("passes the selected external catalog to query execution", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "bi", "Query", "query", undefined, undefined, "paimon_catalog");

    await store.executeTabSql(tabId, "SELECT * FROM events");

    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "bi", "SELECT * FROM events", undefined, expect.any(String), expect.objectContaining({ catalog: "paimon_catalog" }));
  });

  it("keeps old and new executions as result runs, then lets normal execution replace the active run", async () => {
    mocks.executeMulti
      .mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([{ columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([{ columns: ["value"], rows: [[3]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeCurrentSql("SELECT 1 AS value");
    await store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultAutoSave).toBeUndefined();
    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[1]?.id);

    expect(await store.setActiveResultRun(tabId, tab.resultRuns![0]!.id)).toBe(true);
    expect(tab.result?.rows[0]?.[0]).toBe(1);
    expect(await store.setActiveResultRun(tabId, tab.resultRuns![1]!.id)).toBe(true);
    expect(tab.result?.rows[0]?.[0]).toBe(2);

    await store.executeCurrentSql("SELECT 3 AS value");

    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[1]?.id);
    expect(await store.setActiveResultRun(tabId, tab.resultRuns![0]!.id)).toBe(true);
    expect(tab.result?.rows[0]?.[0]).toBe(1);
    expect(await store.setActiveResultRun(tabId, tab.resultRuns![1]!.id)).toBe(true);
    expect(tab.resultRuns?.[1]).toMatchObject({
      sql: "SELECT 3 AS value",
      result: { rows: [[3]] },
    });
  });

  it("keeps ordinary executions in the single-result path by default", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeCurrentSql("SELECT 1 AS value");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.rows).toEqual([[1]]);
    expect(tab.resultRuns).toBeUndefined();
    expect(tab.activeResultRunId).toBeUndefined();
  });

  it("uses the immutable target context instead of the result tab namespace", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "source-db", "Target", "query", "source-schema", "SELECT 1", "source-catalog");

    await store.executeTabSql(tabId, "SELECT 1", {
      targetContext: { scope: "database", database: "target-db", schema: "target-schema" },
    });

    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "target-db", "SELECT 1", "target-schema", expect.any(String), expect.objectContaining({ catalog: undefined }));
  });

  it("clears the database and schema for a connection-scoped target", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "etcd-1", name: "etcd", db_type: "etcd", database: "stale" });
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("etcd-1", "stale", "Target", "query", "stale-schema", "GET /", "stale-catalog");

    await store.executeTabSql(tabId, "GET /", { targetContext: { scope: "connection" } });

    expect(mocks.executeMulti).toHaveBeenCalledWith("etcd-1", "", "GET /", undefined, expect.any(String), expect.objectContaining({ catalog: undefined }));
  });

  it("restores the retained result when a new-result execution fails before dispatch", async () => {
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");
    mocks.ensureConnected.mockRejectedValueOnce(new Error("connection failed"));

    await store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[0]?.id);
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("hydrates a restored active run before starting a new-result execution", async () => {
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    store.toggleResultAutoSave(tabId);
    const run = tab.resultRuns?.[0];
    expect(run?.resultCacheKey).toBeTruthy();
    run!.result = undefined;
    run!.results = undefined;
    tab.result = undefined;
    tab.results = undefined;
    mocks.ensureConnected.mockRejectedValueOnce(new Error("connection failed"));

    await store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });

    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(run?.id);
    expect(tab.result?.rows).toEqual([[1]]);
    expect(mocks.tabResultSnapshots.has(run!.resultCacheKey!)).toBe(true);

    run!.result = undefined;
    run!.results = undefined;
    tab.result = undefined;
    tab.results = undefined;

    expect(await store.setActiveResultRun(tabId, run!.id)).toBe(true);
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("captures a new run when another retained run is selected during execution", async () => {
    const pendingExecution = deferred<Array<{ columns: string[]; rows: number[][]; affected_rows: number; execution_time_ms: number }>>();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]).mockImplementationOnce(() => pendingExecution.promise);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");
    store.toggleResultAutoSave(tabId);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const retainedRunId = tab.activeResultRunId!;
    const retainedRunCacheKey = tab.resultRuns?.find((run) => run.id === retainedRunId)?.resultCacheKey;
    expect(tab.batchSqlExecution?.submittedSql).toBe("SELECT 1 AS value");

    const execution = store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(await store.setActiveResultRun(tabId, retainedRunId)).toBe(true);
    expect(tab.batchSqlExecution?.submittedSql).toBe("SELECT 1 AS value");
    pendingExecution.resolve([{ columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }]);
    await execution;

    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.activeResultRunId).not.toBe(retainedRunId);
    expect(tab.result).toMatchObject({ rows: [[2]] });
    expect(tab.batchSqlExecution?.submittedSql).toBe("SELECT 2 AS value");
    expect(tab.resultRuns?.find((run) => run.id === tab.activeResultRunId)?.resultCacheKey).not.toBe(retainedRunCacheKey);
    expect(await store.setActiveResultRun(tabId, retainedRunId)).toBe(true);
    expect(tab.result).toMatchObject({ rows: [[1]] });
    expect(tab.batchSqlExecution?.submittedSql).toBe("SELECT 1 AS value");

    const newRunId = tab.resultRuns?.find((run) => run.id !== retainedRunId)?.id;
    expect(newRunId).toBeTruthy();
    expect(await store.setActiveResultRun(tabId, newRunId!)).toBe(true);
    await vi.waitFor(() => expect(mocks.tabResultSnapshots.has(retainedRunCacheKey!)).toBe(true));
    const retainedRun = tab.resultRuns?.find((run) => run.id === retainedRunId);
    expect(retainedRun).toBeTruthy();
    retainedRun!.result = undefined;
    retainedRun!.results = undefined;
    retainedRun!.batchSqlExecution = undefined;

    expect(await store.setActiveResultRun(tabId, retainedRunId)).toBe(true);
    expect(tab.result).toMatchObject({ rows: [[1]] });
    expect(tab.batchSqlExecution?.submittedSql).toBe("SELECT 1 AS value");
  });

  it("restores the retained result when a new-result execution returns no result", async () => {
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]).mockResolvedValueOnce([]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");

    await store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[0]?.id);
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("restores the retained result when a new-result execution is cancelled", async () => {
    const pendingExecution = deferred<never>();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]).mockImplementationOnce(() => pendingExecution.promise);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");

    const execution = store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    await expect(store.cancelTabExecution(tabId)).resolves.toBe(true);
    pendingExecution.reject(new Error("Query canceled"));
    await execution;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[0]?.id);
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("keeps the retained result when a cancelled execution still returns data", async () => {
    const pendingExecution = deferred<Array<{ columns: string[]; rows: number[][]; affected_rows: number; execution_time_ms: number }>>();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]).mockImplementationOnce(() => pendingExecution.promise);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");

    const execution = store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    await expect(store.cancelTabExecution(tabId)).resolves.toBe(true);
    pendingExecution.resolve([{ columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }]);
    await execution;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[0]?.id);
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("restores the adjacent retained result after closing the active run", async () => {
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]).mockResolvedValueOnce([{ columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeCurrentSql("SELECT 1 AS value");
    await store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const activeRunId = tab.activeResultRunId!;

    expect(await store.removeResultRun(tabId, activeRunId)).toBe(true);

    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(tab.resultRuns?.[0]?.id);
    expect(tab.result?.rows).toEqual([[1]]);
  });
});
