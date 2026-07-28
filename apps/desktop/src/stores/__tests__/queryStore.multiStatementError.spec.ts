import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
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
  });

  it("opens the first error result from a mixed result batch", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], execution_error: true, rows: [["no such table: missing"]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT * FROM missing");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.result?.columns).toEqual(["Error"]);
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

    const execution = store.executeCurrentSql("SELECT 2 AS value", { openInNewResultTab: true });
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(await store.setActiveResultRun(tabId, retainedRunId)).toBe(true);
    pendingExecution.resolve([{ columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 }]);
    await execution;

    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.activeResultRunId).not.toBe(retainedRunId);
    expect(tab.result).toMatchObject({ rows: [[2]] });
    expect(tab.resultRuns?.find((run) => run.id === tab.activeResultRunId)?.resultCacheKey).not.toBe(retainedRunCacheKey);
    expect(await store.setActiveResultRun(tabId, retainedRunId)).toBe(true);
    expect(tab.result).toMatchObject({ rows: [[1]] });
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
