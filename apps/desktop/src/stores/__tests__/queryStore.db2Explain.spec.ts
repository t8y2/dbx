import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  getExplainInfo: vi.fn(),
  executeQuery: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
  closeClientSession: vi.fn(),
  cancelQuery: vi.fn(),
  editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false, globalQueryTimeoutSecs: 60 },
}));
vi.mock("@/lib/diagram/explainPlan", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/diagram/explainPlan")>()), buildExplainSql: mocks.buildExplainSql }));
vi.mock("@/lib/backend/api", () => ({ getExplainInfo: mocks.getExplainInfo, executeQuery: mocks.executeQuery, saveOpenTabsState: mocks.saveOpenTabsState, closeClientConnectionSession: mocks.closeClientSession, cancelQuery: mocks.cancelQuery }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: mocks.getConfig, recordConnectionLostError: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: mocks.editorSettings }) }));

const SQL = "SELECT * FROM ORDERS";
const EXPLAIN = `EXPLAIN PLAN FOR ${SQL}`;
function plan(type = "RETURN") {
  return JSON.stringify({ version: 1, databaseType: "db2", requestTag: "dbx8834test", operators: [{ id: "1", type, totalCost: "0.5" }], streams: [], predicates: [] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
async function setup() {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const id = store.createTab("db2-1", "DBX8834", "Query", "query", "APP_A");
  return { store, id };
}

describe("queryStore DB2 native EXPLAIN", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.editorSettings.globalQueryTimeoutSecs = 60;
    vi.unstubAllGlobals();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", query_timeout_secs: 30 });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: EXPLAIN });
    mocks.getExplainInfo.mockResolvedValue(plan());
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    mocks.closeClientSession.mockResolvedValue(undefined);
    mocks.cancelQuery.mockResolvedValue(true);
  });

  it("validates SQL and uses native JSON with the selected database/schema", async () => {
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2", "autotrace");
    expect(mocks.buildExplainSql).toHaveBeenCalledWith("db2", SQL);
    expect(mocks.getExplainInfo).toHaveBeenCalledWith("db2-1", "DBX8834", "APP_A", SQL, "explain", expect.any(String), 30);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: undefined, explainSql: EXPLAIN, explainPlan: { databaseType: "db2", raw: plan(), nodes: [{ nodeType: "RETURN", cost: "0.5 timerons", costModel: "unknown" }] } });
  });

  it.each([7, 0])("forwards the inherited editor timeout of %s seconds to native explain", async (timeoutSecs) => {
    mocks.editorSettings.globalQueryTimeoutSecs = timeoutSecs;
    mocks.getConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", query_timeout_secs: 30, query_timeout_inherit: true });
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(mocks.getExplainInfo).toHaveBeenCalledWith("db2-1", "DBX8834", "APP_A", SQL, "explain", expect.any(String), timeoutSecs);
  });

  it("keeps an explicit connection timeout when the editor timeout differs", async () => {
    mocks.editorSettings.globalQueryTimeoutSecs = 7;
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(mocks.getExplainInfo.mock.calls[0][6]).toBe(30);
  });

  it("keeps the query result and business session state intact", async () => {
    const { store, id } = await setup();
    const tab = store.tabs[0];
    tab.result = { columns: ["ID"], rows: [[42]], affected_rows: 0, execution_time_ms: 0 };
    tab.txnSessionId = "active-business-transaction";
    await store.explainTabSql(id, SQL, "db2");
    expect(tab.result?.rows).toEqual([[42]]);
    expect(tab.txnSessionId).toBe("active-business-transaction");
    expect(tab.schema).toBe("APP_A");
    expect(mocks.closeClientSession).not.toHaveBeenCalled();
  });

  it("does not call the Agent for unsafe SQL", async () => {
    mocks.buildExplainSql.mockResolvedValue({ ok: false, reason: "unsafe" });
    const { store, id } = await setup();
    expect(await store.explainTabSql(id, "DELETE FROM ORDERS", "db2")).toEqual({ ok: false, reason: "unsafe" });
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: "unsafe", explainExecutionId: undefined });
  });

  it.each(["SQLSTATE=42704: EXPLAIN tables missing; initialize with SYSINSTALLOBJECTS", "SQLCODE=-551 SQLSTATE=42501: insufficient privileges", "query timed out"])("preserves the backend diagnostic: %s", async (message) => {
    mocks.getExplainInfo.mockRejectedValue(new Error(message));
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainPlan: undefined, explainError: message });
  });

  it("resets state if SQL generation rejects", async () => {
    mocks.buildExplainSql.mockRejectedValue(new Error("SQL parser unavailable"));
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainExecutionId: undefined, explainError: "SQL parser unavailable" });
  });

  it.each(["", undefined])("shows the empty response error for %s", async (value) => {
    mocks.getExplainInfo.mockResolvedValue(value);
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: "No explain plan returned", explainPlan: undefined });
  });

  it("reports malformed native JSON instead of treating it as a MySQL plan", async () => {
    mocks.getExplainInfo.mockResolvedValue("not JSON");
    const { store, id } = await setup();
    await store.explainTabSql(id, SQL, "db2");
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: "DB2 EXPLAIN: invalid JSON plan", explainPlan: undefined });
  });

  it("discards an older response and leaves the newer request loading", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.getExplainInfo.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { store, id } = await setup();
    const oldRequest = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(1));
    const newRequest = store.explainTabSql(id, "SELECT * FROM CUSTOMERS", "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(2));
    first.resolve(plan("OLD"));
    await oldRequest;
    expect(store.tabs[0]).toMatchObject({ isExplaining: true, explainPlan: undefined });
    second.resolve(plan("NEW"));
    await newRequest;
    expect(store.tabs[0].explainPlan?.nodes[0].nodeType).toBe("NEW");
    expect(store.tabs[0].isExplaining).toBe(false);
  });

  it("does not start the Agent after cancellation during SQL generation", async () => {
    const generation = deferred<{ ok: true; sql: string }>();
    mocks.buildExplainSql.mockReturnValue(generation.promise);
    const { store, id } = await setup();
    const request = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.buildExplainSql).toHaveBeenCalledTimes(1));
    await store.cancelTabExplain(id);
    generation.resolve({ ok: true, sql: EXPLAIN });
    await request;
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(store.tabs[0].isExplaining).toBe(false);
  });

  it("uses the native request ID for cancellation and discards its later response", async () => {
    const response = deferred<string>();
    mocks.getExplainInfo.mockReturnValue(response.promise);
    const { store, id } = await setup();
    const request = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(1));
    const executionId = mocks.getExplainInfo.mock.calls[0][5];
    await store.cancelTabExplain(id);
    expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);
    response.resolve(plan());
    await request;
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainPlan: undefined });
  });

  it.each(["connection", "database", "catalog", "schema", "clear-schema"] as const)("cancels unlimited explain on %s changes without disturbing the new request", async (target) => {
    mocks.getConfig.mockReturnValue({ id: "db2-1", name: "DB2", db_type: "db2", query_timeout_secs: 0 });
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const cancellation = deferred<boolean>();
    mocks.getExplainInfo.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    mocks.cancelQuery.mockReturnValue(cancellation.promise);
    const { store, id } = await setup();
    const oldRequest = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(1));
    const executionId = mocks.getExplainInfo.mock.calls[0][5];
    expect(mocks.getExplainInfo.mock.calls[0][6]).toBe(0);

    if (target === "connection") store.updateConnection(id, "db2-2", "SECONDDB");
    else if (target === "database") store.updateDatabase(id, "SECONDDB");
    else if (target === "catalog") store.updateCatalog(id, "SECOND_CATALOG", "DBX8834");
    else store.updateSchema(id, target === "schema" ? "APP_B" : undefined);

    expect(mocks.cancelQuery).toHaveBeenCalledExactlyOnceWith(executionId);
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainExecutionId: undefined, explainPlan: undefined });
    const newRequest = store.explainTabSql(id, "SELECT * FROM CUSTOMERS", "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(2));
    const newExecutionId = mocks.getExplainInfo.mock.calls[1][5];
    expect(newExecutionId).not.toBe(executionId);
    expect(mocks.getExplainInfo.mock.calls[1].slice(0, 3)).toEqual([store.tabs[0].connectionId, store.tabs[0].database, store.tabs[0].schema]);

    cancellation.resolve(true);
    oldResponse.resolve(plan("OLD"));
    await oldRequest;
    expect(store.tabs[0]).toMatchObject({ isExplaining: true, explainExecutionId: newExecutionId, explainPlan: undefined });
    newResponse.resolve(plan("NEW"));
    await newRequest;
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainExecutionId: undefined });
    expect(store.tabs[0].explainPlan?.nodes[0].nodeType).toBe("NEW");
  });

  it.each(["connection", "database", "catalog", "schema"] as const)("keeps the pending explain when the %s target is unchanged", async (target) => {
    const response = deferred<string>();
    mocks.getExplainInfo.mockReturnValue(response.promise);
    const { store, id } = await setup();
    const request = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(1));
    const executionId = mocks.getExplainInfo.mock.calls[0][5];
    if (target === "connection") store.updateConnection(id, "db2-1", "DBX8834");
    else if (target === "database") store.updateDatabase(id, "DBX8834");
    else if (target === "catalog") store.updateCatalog(id, undefined, "DBX8834");
    else store.updateSchema(id, "APP_A");
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: true, explainExecutionId: executionId });
    response.resolve(plan());
    await request;
    expect(store.tabs[0].explainPlan?.nodes[0].nodeType).toBe("RETURN");
  });

  it("does not start native explain after the target changes during SQL generation even if cancellation fails", async () => {
    const generation = deferred<{ ok: true; sql: string }>();
    mocks.buildExplainSql.mockReturnValue(generation.promise);
    mocks.cancelQuery.mockRejectedValue(new Error("cancel unavailable"));
    const { store, id } = await setup();
    const request = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.buildExplainSql).toHaveBeenCalledTimes(1));
    const executionId = store.tabs[0].explainExecutionId;
    store.updateDatabase(id, "SECONDDB");
    expect(mocks.cancelQuery).toHaveBeenCalledExactlyOnceWith(executionId);
    generation.resolve({ ok: true, sql: EXPLAIN });
    await request;
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainExecutionId: undefined, explainPlan: undefined });
  });

  it("ignores a response after the tab is closed", async () => {
    const response = deferred<string>();
    mocks.getExplainInfo.mockReturnValue(response.promise);
    const { store, id } = await setup();
    const request = store.explainTabSql(id, SQL, "db2");
    await vi.waitFor(() => expect(mocks.getExplainInfo).toHaveBeenCalledTimes(1));
    store.closeTab(id, { force: true });
    response.resolve(plan());
    await request;
    expect(store.tabs.find((tab) => tab.id === id)).toBeUndefined();
  });
});
