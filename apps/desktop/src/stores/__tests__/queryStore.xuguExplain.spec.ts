import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ buildExplainSql: vi.fn(), executeQuery: vi.fn(), closeClientSession: vi.fn(), saveOpenTabsState: vi.fn(), getConfig: vi.fn(), getExplainInfo: vi.fn() }));
vi.mock("@/lib/diagram/explainPlan", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/diagram/explainPlan")>()), buildExplainSql: mocks.buildExplainSql }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, closeClientConnectionSession: mocks.closeClientSession, saveOpenTabsState: mocks.saveOpenTabsState, getExplainInfo: mocks.getExplainInfo }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: mocks.getConfig, recordConnectionLostError: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false } }) }));

const SQL = "SELECT * FROM ORDERS WHERE ID = 1";
const EXPLAIN = `EXPLAIN VERBOSE ${SQL}`;
const PLAN: QueryResult = { columns: ["plan_path"], rows: [["1   SeqScan[(1 1) cost=0,result_num=1](table=ORDERS)"]], affected_rows: 0, execution_time_ms: 1 };

describe("queryStore Xugu EXPLAIN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "xugu-1", name: "Xugu", db_type: "xugu", query_timeout_secs: 30 });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: EXPLAIN });
    mocks.executeQuery.mockResolvedValue(PLAN);
    mocks.closeClientSession.mockResolvedValue(undefined);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("uses the scoped query path, real parser, timeout and existing session cleanup", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", "SHOP_DEMO", "Query", "query", "APP_TEST");
    await store.explainTabSql(id, SQL, "xugu");
    expect(mocks.executeQuery).toHaveBeenCalledWith("xugu-1", "SHOP_DEMO", EXPLAIN, "APP_TEST", expect.any(String), expect.objectContaining({ clientSessionId: `${id}:explain`, timeoutSecs: 30 }));
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(mocks.closeClientSession).toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === id)).toMatchObject({ isExplaining: false, explainError: undefined, explainSql: EXPLAIN, explainPlan: { databaseType: "xugu", nodes: [{ nodeType: "SeqScan", relation: "ORDERS", rows: "1" }] } });
  });

  it("does not enable actual execution when an autotrace mode is accidentally requested", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", "SYSTEM", "Query", "query", "SYSDBA");
    await store.explainTabSql(id, SQL, "xugu", "autotrace");
    expect(mocks.buildExplainSql).toHaveBeenCalledWith("xugu", SQL);
    expect(mocks.executeQuery).toHaveBeenCalledWith("xugu-1", "SYSTEM", EXPLAIN, "SYSDBA", expect.any(String), expect.objectContaining({ executionMode: undefined }));
  });

  it.each(["SYSTEM", "SHOP_DEMO"])("preserves the selected %s database", async (database) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", database, "Query", "query", "OWNER_B");
    await store.explainTabSql(id, SQL, "xugu");
    expect(mocks.executeQuery.mock.calls[0].slice(0, 4)).toEqual(["xugu-1", database, EXPLAIN, "OWNER_B"]);
  });

  it("does not send rejected SQL to the Agent", async () => {
    mocks.buildExplainSql.mockResolvedValue({ ok: false, reason: "unsafe" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", "SYSTEM", "Query", "query");
    expect(await store.explainTabSql(id, "DELETE FROM ORDERS", "xugu")).toEqual({ ok: false, reason: "unsafe" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: "unsafe", explainPlan: undefined });
  });

  it.each(["permission denied", "query timed out"])("surfaces %s and closes the explain session", async (message) => {
    mocks.executeQuery.mockRejectedValue(new Error(message));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", "SHOP_DEMO", "Query", "query", "APP_TEST");
    await store.explainTabSql(id, SQL, "xugu");
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: message, explainPlan: undefined });
    expect(mocks.closeClientSession).toHaveBeenCalled();
  });

  it("does not turn an explicit execution-error result into a successful plan", async () => {
    mocks.executeQuery.mockResolvedValue({ ...PLAN, columns: ["Error"], rows: [["[E5021] object not found"]], execution_error: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("xugu-1", "SYSTEM", "Query", "query");
    await store.explainTabSql(id, SQL, "xugu");
    expect(store.tabs[0]).toMatchObject({ isExplaining: false, explainError: "[E5021] object not found", explainPlan: undefined });
  });
});
