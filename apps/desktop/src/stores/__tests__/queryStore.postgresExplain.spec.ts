import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  parseExplainResult: vi.fn(),
  executeQuery: vi.fn(),
  closeClientSession: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/diagram/explainPlan", () => ({
  buildExplainSql: mocks.buildExplainSql,
  parseExplainResult: mocks.parseExplainResult,
  parseDamengExplainText: vi.fn(),
  parseOracleExplainText: vi.fn(),
  sqlServerExplainResult: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  closeClientConnectionSession: mocks.closeClientSession,
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

const SOURCE_SQL = "SELECT * FROM orders";

async function explain(explainMode?: string) {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const tabId = store.createTab("pg-1", "shop", "Query", "query", "public");
  await store.explainTabSql(tabId, SOURCE_SQL, "postgres", explainMode);
  return { store, tabId };
}

describe("queryStore PostgreSQL EXPLAIN ANALYZE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "pg-1", name: "Postgres", db_type: "postgres" });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: "EXPLAIN (FORMAT JSON) SELECT * FROM orders" });
    mocks.executeQuery.mockResolvedValue({ columns: ["QUERY PLAN"], rows: [["[]"]], affected_rows: 0, execution_time_ms: 1 });
    mocks.parseExplainResult.mockReturnValue({ databaseType: "postgres", raw: [], nodes: [] });
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("requests ANALYZE when the autotrace toggle is on", async () => {
    await explain("autotrace");

    expect(mocks.buildExplainSql).toHaveBeenCalledTimes(1);
    expect(mocks.buildExplainSql).toHaveBeenCalledWith("postgres", SOURCE_SQL, "json", true);
  });

  it("leaves the plain explain call untouched in the default mode", async () => {
    const { tabId } = await explain();

    expect(mocks.buildExplainSql).toHaveBeenCalledWith("postgres", SOURCE_SQL);
    expect(mocks.executeQuery.mock.calls[0][5]).toMatchObject({ clientSessionId: `${tabId}:explain` });
    expect(mocks.executeQuery.mock.calls[0][5].executionMode).toBeUndefined();
  });

  it("leaves the plain explain call untouched when the toggle is explicitly off", async () => {
    await explain("explain");

    expect(mocks.buildExplainSql).toHaveBeenCalledWith("postgres", SOURCE_SQL);
  });

  it("runs the analyzed statement the backend built and parses its plan", async () => {
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM orders" });
    const parsedPlan = { databaseType: "postgres", raw: [], nodes: [{ id: "0", title: "Sort", nodeType: "Sort", details: ["Actual Rows: 84000"], children: [] }] };
    mocks.parseExplainResult.mockReturnValue(parsedPlan);

    const { store, tabId } = await explain("autotrace");

    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
    expect(mocks.executeQuery.mock.calls[0][2]).toBe("EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM orders");
    expect(mocks.executeQuery.mock.calls[0][5]).toMatchObject({
      clientSessionId: expect.stringMatching(new RegExp(`^${tabId}:explain:`)),
      executionMode: "postgres_read_only_transaction",
    });
    expect(mocks.closeClientSession).toHaveBeenCalledWith("pg-1", "shop", mocks.executeQuery.mock.calls[0][5].clientSessionId);
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainClientSessionId: undefined,
      explainPlan: parsedPlan,
      explainSql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM orders",
      explainError: undefined,
    });
  });

  it("surfaces a backend rejection of the analyzed statement", async () => {
    mocks.buildExplainSql.mockResolvedValue({ ok: false, reason: "unsafe" });

    const { store, tabId } = await explain("autotrace");

    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainPlan: undefined,
      explainError: "unsafe",
    });
  });

  it("closes the isolated session after an analyzed query error", async () => {
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM orders" });
    mocks.executeQuery.mockRejectedValue(new Error("query failed"));

    const { store, tabId } = await explain("autotrace");
    const clientSessionId = mocks.executeQuery.mock.calls[0][5].clientSessionId;

    expect(mocks.closeClientSession).toHaveBeenCalledWith("pg-1", "shop", clientSessionId);
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainClientSessionId: undefined,
      explainPlan: undefined,
      explainError: "query failed",
    });
  });

  it("does not send the analyze flag for other engines sharing this path", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "shop", "Query", "query", "public");

    await store.explainTabSql(tabId, SOURCE_SQL, "questdb", "autotrace");

    expect(mocks.buildExplainSql).toHaveBeenCalledWith("questdb", SOURCE_SQL);
  });
});
