import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  parseExplainResult: vi.fn(),
  parseDamengExplainText: vi.fn(),
  parseOracleExplainText: vi.fn(),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/diagram/explainPlan", () => ({
  buildExplainSql: mocks.buildExplainSql,
  parseExplainResult: mocks.parseExplainResult,
  parseDamengExplainText: mocks.parseDamengExplainText,
  parseOracleExplainText: mocks.parseOracleExplainText,
}));

vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false },
  }),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const standardSql = "EXPLAIN SELECT * FROM users WHERE status = 'active'";
const jsonSql = "EXPLAIN FORMAT=JSON SELECT * FROM users WHERE status = 'active'";
const sourceSql = "SELECT * FROM users WHERE status = 'active'";

const tableResult: QueryResult = {
  columns: ["id", "select_type", "table", "type", "rows", "Extra"],
  rows: [[1, "SIMPLE", "users", "ref", 12, "Using where"]],
  affected_rows: 0,
  execution_time_ms: 4,
};

const jsonResult: QueryResult = {
  columns: ["EXPLAIN"],
  rows: [['{"query_block":{"select_id":1}}']],
  affected_rows: 0,
  execution_time_ms: 5,
};

const visualPlan: ParsedExplainPlan = {
  databaseType: "mysql",
  raw: { query_block: { select_id: 1 } },
  nodes: [],
};

function configureSuccessfulBuilds() {
  mocks.buildExplainSql.mockImplementation(async (_databaseType: string, _sql: string, format: "standard" | "json") => ({
    ok: true,
    sql: format === "standard" ? standardSql : jsonSql,
  }));
}

describe("queryStore MySQL dual explain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());

    mocks.getConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      query_timeout_secs: 45,
    });
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.closeClientConnectionSession.mockResolvedValue(undefined);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    mocks.parseExplainResult.mockReturnValue(visualPlan);
    configureSuccessfulBuilds();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes standard EXPLAIN before JSON EXPLAIN using one execution and client session", async () => {
    const standardExecution = deferred<QueryResult>();
    mocks.executeQuery.mockImplementationOnce(() => standardExecution.promise).mockResolvedValueOnce(jsonResult);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", "analytics");
    const explain = store.explainTabSql(tabId, sourceSql, "mysql");

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(1));
    expect(mocks.buildExplainSql).toHaveBeenNthCalledWith(1, "mysql", sourceSql, "standard");
    expect(mocks.buildExplainSql).toHaveBeenNthCalledWith(2, "mysql", sourceSql, "json");
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(1, "mysql-1", "app", standardSql, "analytics", expect.any(String), expect.objectContaining({ timeoutSecs: 45 }));

    standardExecution.resolve(tableResult);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await explain;

    const standardCall = mocks.executeQuery.mock.calls[0]!;
    const jsonCall = mocks.executeQuery.mock.calls[1]!;
    const executionId = standardCall[4] as string;
    const standardOptions = standardCall[5] as { clientSessionId: string; timeoutSecs: number };
    const jsonOptions = jsonCall[5] as { clientSessionId: string; timeoutSecs: number };
    const tab = store.tabs.find((item) => item.id === tabId)!;

    expect(jsonCall[0]).toBe("mysql-1");
    expect(jsonCall[1]).toBe("app");
    expect(jsonCall[2]).toBe(jsonSql);
    expect(jsonCall[3]).toBe("analytics");
    expect(jsonCall[4]).toBe(executionId);
    expect(jsonOptions.clientSessionId).toBe(standardOptions.clientSessionId);
    expect(standardOptions.clientSessionId).toBe(`${tabId}:explain:${executionId}`);
    expect(jsonOptions.timeoutSecs).toBe(45);
    expect(mocks.parseExplainResult).toHaveBeenCalledWith("mysql", jsonResult);
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainPlan).toEqual(visualPlan);
    expect(tab.explainTableSql).toBe(standardSql);
    expect(tab.explainSql).toBe(jsonSql);
    expect(tab.isExplaining).toBe(false);
    expect(tab.explainExecutionId).toBeUndefined();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("mysql-1", "app", standardOptions.clientSessionId));
  });

  it("keeps the JSON visual plan when the standard table EXPLAIN fails", async () => {
    mocks.executeQuery.mockRejectedValueOnce(new Error("standard EXPLAIN failed")).mockResolvedValueOnce(jsonResult);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(1, "mysql-1", "app", standardSql, undefined, expect.any(String), expect.any(Object));
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(2, "mysql-1", "app", jsonSql, undefined, expect.any(String), expect.any(Object));
    expect(tab.explainTableResult).toBeUndefined();
    expect(tab.explainTableError).toBe("standard EXPLAIN failed");
    expect(tab.explainPlan).toEqual(visualPlan);
    expect(tab.explainError).toBeUndefined();
    expect(tab.isExplaining).toBe(false);
  });

  it.each([
    ["is acknowledged", () => mocks.cancelQuery.mockResolvedValue(true), true],
    ["returns false", () => mocks.cancelQuery.mockResolvedValue(false), false],
    ["rejects", () => mocks.cancelQuery.mockRejectedValue(new Error("cancel request failed")), false],
  ])("does not start JSON EXPLAIN when cancellation %s during standard EXPLAIN", async (_label, configureCancel, expectedResult) => {
    const standardExecution = deferred<QueryResult>();
    mocks.executeQuery.mockImplementationOnce(() => standardExecution.promise);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const explain = store.explainTabSql(tabId, sourceSql, "mysql");

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(1));
    const executionId = store.tabs.find((item) => item.id === tabId)?.explainExecutionId;
    expect(executionId).toEqual(expect.any(String));

    configureCancel();
    await expect(store.cancelTabExplain(tabId)).resolves.toBe(expectedResult);
    expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);

    standardExecution.resolve(tableResult);
    await explain;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
    expect(tab.explainTableResult).toBeUndefined();
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.isExplaining).toBe(false);
    expect(tab.explainExecutionId).toBeUndefined();
  });

  it.each([
    ["returns false", () => mocks.cancelQuery.mockResolvedValue(false)],
    ["rejects", () => mocks.cancelQuery.mockRejectedValue(new Error("cancel request failed"))],
  ])("does not start either EXPLAIN when cancellation %s while SQL formats are building", async (_label, configureCancel) => {
    const standardBuild = deferred<{ ok: true; sql: string }>();
    const jsonBuild = deferred<{ ok: true; sql: string }>();
    mocks.buildExplainSql.mockImplementation((_databaseType: string, _sql: string, format: "standard" | "json") => (format === "standard" ? standardBuild.promise : jsonBuild.promise));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const explain = store.explainTabSql(tabId, sourceSql, "mysql");

    await vi.waitFor(() => expect(mocks.buildExplainSql).toHaveBeenCalledTimes(2));
    configureCancel();
    await expect(store.cancelTabExplain(tabId)).resolves.toBe(false);

    standardBuild.resolve({ ok: true, sql: standardSql });
    jsonBuild.resolve({ ok: true, sql: jsonSql });
    await explain;

    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("clears loading state when one of the format builders rejects", async () => {
    mocks.buildExplainSql.mockRejectedValueOnce(new Error("format builder unavailable"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await expect(store.explainTabSql(tabId, sourceSql, "mysql")).resolves.toEqual({ ok: true, sql: "" });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(tab).toMatchObject({
      isExplaining: false,
      explainExecutionId: undefined,
      explainError: "format builder unavailable",
    });
  });
});
