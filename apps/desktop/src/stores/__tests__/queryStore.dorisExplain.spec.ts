import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

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

const SOURCE_SQL = "SELECT * FROM users";
const EXPLAIN_SQL = "EXPLAIN SELECT * FROM users";
const DORIS_RESULT: QueryResult = {
  columns: ["Explain String"],
  rows: [["PLAN FRAGMENT 0"], ["  0:VSCAN NODE"]],
  affected_rows: 0,
  execution_time_ms: 1,
};
const PARSED_PLAN = { databaseType: "doris", raw: "PLAN FRAGMENT 0\n  0:VSCAN NODE", nodes: [] };

describe("queryStore Doris EXPLAIN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "doris-1", name: "Doris", db_type: "doris", query_timeout_secs: 30 });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: EXPLAIN_SQL });
    mocks.executeQuery.mockResolvedValue(DORIS_RESULT);
    mocks.parseExplainResult.mockReturnValue(PARSED_PLAN);
    mocks.closeClientSession.mockResolvedValue(undefined);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("executes native EXPLAIN and dispatches the text result to the Doris parser", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("doris-1", "analytics", "Query", "query", "warehouse");

    await store.explainTabSql(tabId, SOURCE_SQL, "doris");

    expect(mocks.buildExplainSql).toHaveBeenCalledWith("doris", SOURCE_SQL);
    expect(mocks.executeQuery).toHaveBeenCalledWith("doris-1", "analytics", EXPLAIN_SQL, "warehouse", expect.any(String), expect.objectContaining({ clientSessionId: `${tabId}:explain` }));
    expect(mocks.parseExplainResult).toHaveBeenCalledWith("doris", DORIS_RESULT);
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainPlan: PARSED_PLAN,
      explainSql: EXPLAIN_SQL,
      explainError: undefined,
    });
  });
});
