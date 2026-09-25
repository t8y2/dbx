import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendErrorException, formatError } from "@/lib/backend/errorUtils";
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

const standardSql = "EXPLAIN FORMAT=TRADITIONAL SELECT * FROM users WHERE status = 'active'";
const textSql = "EXPLAIN FORMAT=TEXT SELECT * FROM users WHERE status = 'active'";
const jsonSql = "EXPLAIN FORMAT=JSON SELECT * FROM users WHERE status = 'active'";
const sourceSql = "SELECT * FROM users WHERE status = 'active'";
const tidbSourceSql = `select ti.id invoiceId,
       ti.invoice_no invoiceNo,
       ti.invoice_amount invoiceAmount
  from ti_oms.ts_invoice ti
  where ti.invoice_status in (3, 5, 6, 8)
    and ti.id in(1,2)`;
const tidbJsonError = "Server error: `ERROR 1105 (HY000): explain format 'JSON' is not supported now` SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement";
const tidbBackendError = new BackendErrorException(tidbJsonError).backendError;

const tidbTableResult: QueryResult = {
  columns: ["id", "estRows", "task", "access object", "operator info"],
  rows: [
    ["Projection_4", "0.01", "root", "", "ti_oms.ts_invoice.id, ti_oms.ts_invoice.invoice_no, ti_oms.ts_invoice.invoice_amount"],
    ["└─Selection_6", "0.01", "root", "", "in(ti_oms.ts_invoice.invoice_status, 3, 5, 6, 8)"],
    ["  └─Batch_Point_Get_5", "2.00", "root", "table:ts_invoice", "handle:[1 2], keep order:false, desc:false"],
  ],
  affected_rows: 0,
  execution_time_ms: 4,
};

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

  it("retries ADB MySQL with TEXT and skips its advertised unsupported JSON format", async () => {
    mocks.executeQuery.mockRejectedValueOnce(new Error("TRADITIONAL is an INVALID EXPLAIN option, valid options are: [TEXT, GRAPHVIZ, DETAIL, SIMPLE]")).mockResolvedValueOnce(tableResult);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query", "query", "analytics");

    await expect(store.explainTabSql(tabId, sourceSql, "mysql")).resolves.toEqual({ ok: true, sql: textSql });

    const firstOptions = mocks.executeQuery.mock.calls[0]?.[5] as { clientSessionId: string };
    const secondOptions = mocks.executeQuery.mock.calls[1]?.[5] as { clientSessionId: string };
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(1, "mysql-1", "app", standardSql, "analytics", expect.any(String), expect.any(Object));
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(2, "mysql-1", "app", textSql, "analytics", expect.any(String), expect.any(Object));
    expect(secondOptions.clientSessionId).toBe(firstOptions.clientSessionId);
    expect(mocks.parseExplainResult).not.toHaveBeenCalled();
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainTableSql).toBe(textSql);
    expect(tab.explainTableError).toBeUndefined();
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainSql).toBeUndefined();
    expect(tab.explainError).toBeUndefined();
  });

  it("keeps the standard table usable when JSON is the rejected ADB format", async () => {
    mocks.executeQuery.mockResolvedValueOnce(tableResult).mockRejectedValueOnce(new Error("JSON is an INVALID EXPLAIN option, valid options are: [TEXT, GRAPHVIZ, DETAIL, SIMPLE]"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainSql).toBe(jsonSql);
    expect(tab.explainError).toBeUndefined();
  });

  it.each([
    ["string", tidbJsonError],
    ["Error", new Error(tidbJsonError)],
    ["message", { message: tidbJsonError }],
    ["backend envelope", tidbBackendError],
    ["backend exception", new BackendErrorException(tidbBackendError)],
    ["nested backendError", { backendError: tidbBackendError }],
    ["nested error", { error: tidbBackendError }],
    ["serialized envelope", JSON.stringify(tidbBackendError)],
  ])("keeps the screenshot table usable after the reported TiDB JSON rejection as %s", async (_label, error) => {
    const tidbStandardSql = `EXPLAIN FORMAT=TRADITIONAL ${tidbSourceSql}`;
    const tidbJsonSql = `EXPLAIN FORMAT=JSON ${tidbSourceSql}`;
    mocks.buildExplainSql.mockImplementation(async (_databaseType: string, sql: string, format: string) => ({
      ok: true,
      sql: `EXPLAIN FORMAT=${format === "standard" ? "TRADITIONAL" : "JSON"} ${sql}`,
    }));
    mocks.executeQuery.mockResolvedValueOnce(tidbTableResult).mockRejectedValueOnce(error);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "ti_oms", "Query");

    await expect(store.explainTabSql(tabId, tidbSourceSql, "mysql")).resolves.toEqual({ ok: true, sql: tidbJsonSql });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.buildExplainSql).toHaveBeenNthCalledWith(1, "mysql", tidbSourceSql, "standard");
    expect(mocks.buildExplainSql).toHaveBeenNthCalledWith(2, "mysql", tidbSourceSql, "json");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(1, "mysql-1", "ti_oms", tidbStandardSql, undefined, expect.any(String), expect.any(Object));
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(2, "mysql-1", "ti_oms", tidbJsonSql, undefined, expect.any(String), expect.any(Object));
    expect(mocks.parseExplainResult).not.toHaveBeenCalled();
    expect(tab.explainTableResult).toEqual(tidbTableResult);
    expect(tab.explainTableSql).toBe(tidbStandardSql);
    expect(tab.lastExplainedSql).toBe(tidbSourceSql);
    expect(tab.explainTableError).toBeUndefined();
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainSql).toBe(tidbJsonSql);
    expect(tab.explainError).toBeUndefined();
    expect(tab.isExplaining).toBe(false);
    expect(tab.explainExecutionId).toBeUndefined();
  });

  it.each([
    "ERROR 1105 (HY000): Invalid JSON text",
    "ERROR 1064 (42000): syntax error near 'JSON'",
    "ERROR 1045 (28000): Access denied for JSON EXPLAIN",
    "ERROR 1142 (42000): SELECT command denied during JSON EXPLAIN",
    "Lost connection during EXPLAIN FORMAT=JSON",
    "Query timeout during EXPLAIN FORMAT=JSON",
    "explain format 'TEXT' is not supported now",
    "explain format 'TIDB_JSON' is not supported now",
    null,
    undefined,
  ])("keeps a real JSON request failure visible despite a table plan: %j", async (error) => {
    mocks.executeQuery.mockResolvedValueOnce(tableResult).mockRejectedValueOnce(error);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainTableSql).toBe(standardSql);
    expect(tab.lastExplainedSql).toBe(sourceSql);
    expect(tab.explainSql).toBe(jsonSql);
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainError).toBe(formatError(error));
  });

  it.each([
    ["rejects", () => mocks.executeQuery.mockRejectedValueOnce(new Error("standard EXPLAIN failed")), "standard EXPLAIN failed"],
    ["returns null", () => mocks.executeQuery.mockResolvedValueOnce(null), undefined],
    ["returns undefined", () => mocks.executeQuery.mockResolvedValueOnce(undefined), undefined],
  ])("keeps the TiDB JSON failure visible when the table request %s", async (_label, configureTable, tableError) => {
    configureTable();
    mocks.executeQuery.mockRejectedValueOnce(new Error(tidbJsonError));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(tab.explainTableResult).toBeUndefined();
    expect(tab.explainTableError).toBe(tableError);
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainError).toBe(tidbJsonError);
    expect(tab.isExplaining).toBe(false);
  });

  it("still uses JSON when the next request succeeds after a TiDB rejection", async () => {
    mocks.executeQuery.mockResolvedValueOnce(tableResult).mockRejectedValueOnce(new Error(tidbJsonError)).mockResolvedValueOnce(tableResult).mockResolvedValueOnce(jsonResult);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");
    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(4);
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(4, "mysql-1", "app", jsonSql, undefined, expect.any(String), expect.any(Object));
    expect(mocks.parseExplainResult).toHaveBeenCalledOnce();
    expect(mocks.parseExplainResult).toHaveBeenCalledWith("mysql", jsonResult);
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainPlan).toEqual(visualPlan);
    expect(tab.explainError).toBeUndefined();
  });

  it("retains JSON after a TEXT fallback when the server advertises JSON support", async () => {
    mocks.executeQuery.mockRejectedValueOnce(new Error("TRADITIONAL is an INVALID EXPLAIN option, valid options are: [TEXT, JSON]")).mockResolvedValueOnce(tableResult).mockResolvedValueOnce(jsonResult);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.explainTabSql(tabId, sourceSql, "mysql");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeQuery).toHaveBeenCalledTimes(3);
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(2, "mysql-1", "app", textSql, undefined, expect.any(String), expect.any(Object));
    expect(mocks.executeQuery).toHaveBeenNthCalledWith(3, "mysql-1", "app", jsonSql, undefined, expect.any(String), expect.any(Object));
    expect(tab.explainTableResult).toEqual(tableResult);
    expect(tab.explainTableSql).toBe(textSql);
    expect(tab.explainPlan).toEqual(visualPlan);
    expect(tab.explainError).toBeUndefined();
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
