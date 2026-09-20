import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  executeQuery: vi.fn(),
  getExplainInfo: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/diagram/explainPlan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/diagram/explainPlan")>()),
  buildExplainSql: mocks.buildExplainSql,
}));

vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  getExplainInfo: mocks.getExplainInfo,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig, recordConnectionLostError: vi.fn() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false } }),
}));

describe("queryStore OceanBase Oracle explain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle" });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: "EXPLAIN FORMAT=JSON SELECT 1 FROM DUAL" });
    mocks.executeQuery.mockResolvedValue({
      columns: ["Query Plan"],
      rows: ["{", '  "ID":0,', '  "OPERATOR":"EXPRESSION",', '  "NAME":"",', '  "EST.ROWS":1,', '  "EST.TIME(us)":1', "}"].map((line) => [line]),
      affected_rows: 0,
      execution_time_ms: 1,
    });
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("executes the JSON explain SQL and routes its rows to the OceanBase parser", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ob-1", "test", "Query", "query", "APP");
    const result = await store.explainTabSql(tabId, "SELECT 1 FROM DUAL", "oceanbase-oracle");

    expect(result).toEqual({ ok: true, sql: "EXPLAIN FORMAT=JSON SELECT 1 FROM DUAL" });
    expect(mocks.executeQuery).toHaveBeenCalledWith("ob-1", "test", "EXPLAIN FORMAT=JSON SELECT 1 FROM DUAL", "APP", expect.any(String), expect.any(Object));
    expect(mocks.getExplainInfo).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainError: undefined,
      explainSql: "EXPLAIN FORMAT=JSON SELECT 1 FROM DUAL",
      explainPlan: { databaseType: "oceanbase-oracle", nodes: [{ id: "0", nodeType: "EXPRESSION", rows: "1", details: ["Estimated time: 1 µs"] }] },
    });
  });
});
