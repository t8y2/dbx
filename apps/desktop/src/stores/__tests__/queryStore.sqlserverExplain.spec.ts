import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  parseExplainResult: vi.fn(),
  sqlServerExplainResult: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/diagram/explainPlan", () => ({
  buildExplainSql: mocks.buildExplainSql,
  parseExplainResult: mocks.parseExplainResult,
  parseDamengExplainText: vi.fn(),
  parseOracleExplainText: vi.fn(),
  sqlServerExplainResult: mocks.sqlServerExplainResult,
}));

vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeMulti: mocks.executeMulti,
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

const sourceSql = "SELECT * FROM dbo.orders WHERE status = 'paid'";
const explainSql = `SET SHOWPLAN_XML ON;
GO
${sourceSql}
GO
SET SHOWPLAN_XML OFF;`;
const planResult: QueryResult = {
  columns: ["Microsoft SQL Server 2005 XML Showplan"],
  rows: [["<ShowPlanXML />"]],
  affected_rows: 0,
  execution_time_ms: 2,
};
const visualPlan: ParsedExplainPlan = { databaseType: "sqlserver", raw: "<ShowPlanXML />", nodes: [] };

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore SQL Server explain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "sqlserver-1", db_type: "sqlserver", query_timeout_secs: 45 });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: explainSql });
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });
    mocks.executeMulti.mockResolvedValue([planResult]);
    mocks.sqlServerExplainResult.mockReturnValue({ result: planResult });
    mocks.parseExplainResult.mockReturnValue(visualPlan);
    mocks.closeClientConnectionSession.mockResolvedValue(true);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("executes all SHOWPLAN batches in an isolated session and closes it", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "dbx_explain_plan_test", "Query", "query", "dbo");

    await store.explainTabSql(tabId, sourceSql, "sqlserver");

    const enableCall = mocks.executeQuery.mock.calls[0]!;
    const planCall = mocks.executeMulti.mock.calls[0]!;
    const disableCall = mocks.executeQuery.mock.calls[1]!;
    const executionId = enableCall[4] as string;
    const clientSessionId = enableCall[5].clientSessionId as string;
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(enableCall.slice(0, 4)).toEqual(["sqlserver-1", "dbx_explain_plan_test", "SET SHOWPLAN_XML ON;", "dbo"]);
    expect(planCall.slice(0, 4)).toEqual(["sqlserver-1", "dbx_explain_plan_test", sourceSql, "dbo"]);
    expect(disableCall.slice(0, 4)).toEqual(["sqlserver-1", "dbx_explain_plan_test", "SET SHOWPLAN_XML OFF;", "dbo"]);
    expect(planCall[4]).toBe(executionId);
    expect(disableCall[4]).toBeUndefined();
    expect(clientSessionId).toBe(`${tabId}:explain:${executionId}`);
    expect(enableCall[5]).toMatchObject({ clientSessionId, timeoutSecs: 45, executionMode: "simple" });
    expect(planCall[5]).toMatchObject({ clientSessionId, timeoutSecs: 45, executionMode: "simple" });
    expect(disableCall[5]).toMatchObject({ clientSessionId, timeoutSecs: 5, executionMode: "simple" });
    expect(mocks.parseExplainResult).toHaveBeenCalledWith("sqlserver", planResult);
    expect(tab.explainPlan).toEqual(visualPlan);
    expect(tab.explainError).toBeUndefined();
    expect(tab.isExplaining).toBe(false);
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("sqlserver-1", "dbx_explain_plan_test", clientSessionId));
  });

  it("shows an execution error and still closes the SHOWPLAN session", async () => {
    mocks.sqlServerExplainResult.mockReturnValue({ error: "Invalid object name 'missing_table'" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "dbx_explain_plan_test", "Query");

    await store.explainTabSql(tabId, sourceSql, "sqlserver");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.explainPlan).toBeUndefined();
    expect(tab.explainError).toBe("Invalid object name 'missing_table'");
    expect(mocks.parseExplainResult).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.executeQuery.mock.calls[1]?.[2]).toBe("SET SHOWPLAN_XML OFF;");
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledTimes(1));
  });

  it("does not execute the source SQL when SHOWPLAN cannot be enabled", async () => {
    mocks.executeQuery.mockReset().mockRejectedValueOnce(new Error("SHOWPLAN permission denied"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-1", "dbx_explain_plan_test", "Query");

    await store.explainTabSql(tabId, sourceSql, "sqlserver");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.explainError).toBe("SHOWPLAN permission denied");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls[0]?.[2]).toBe("SET SHOWPLAN_XML ON;");
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledTimes(1));
  });
});
