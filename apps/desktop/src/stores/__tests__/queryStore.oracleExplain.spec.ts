import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExplainSql: vi.fn(),
  getExplainInfo: vi.fn(),
  parseOracleExplainText: vi.fn(),
  saveOpenTabsState: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/diagram/explainPlan", () => ({
  buildExplainSql: mocks.buildExplainSql,
  parseExplainResult: vi.fn(),
  parseDamengExplainText: vi.fn(),
  parseOracleExplainText: mocks.parseOracleExplainText,
}));

vi.mock("@/lib/backend/api", () => ({
  getExplainInfo: mocks.getExplainInfo,
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

describe("queryStore Oracle explain errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle" });
    mocks.buildExplainSql.mockResolvedValue({ ok: true, sql: "EXPLAIN PLAN FOR SELECT * FROM DUAL" });
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("shows the real ORA error returned by the backend", async () => {
    mocks.getExplainInfo.mockRejectedValue(new Error("ORA-01031: insufficient privileges"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");

    await store.explainTabSql(tabId, "SELECT * FROM DUAL", "oracle");

    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      isExplaining: false,
      explainPlan: undefined,
      explainError: "ORA-01031: insufficient privileges",
    });
  });

  it("shows string Agent errors without replacing them", async () => {
    mocks.getExplainInfo.mockRejectedValue("Agent error: DBMS_XPLAN execution failed");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.explainTabSql(tabId, "SELECT * FROM DUAL", "oracle");

    expect(store.tabs.find((tab) => tab.id === tabId)?.explainError).toBe("Agent error: DBMS_XPLAN execution failed");
  });

  it("keeps the empty-plan message for a successful empty response", async () => {
    mocks.getExplainInfo.mockResolvedValue("");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.explainTabSql(tabId, "SELECT * FROM DUAL", "oracle");

    expect(store.tabs.find((tab) => tab.id === tabId)?.explainError).toBe("No explain plan returned");
    expect(mocks.parseOracleExplainText).not.toHaveBeenCalled();
  });

  it("keeps successful Oracle explain behavior unchanged", async () => {
    const parsedPlan = { databaseType: "oracle", rawText: "Plan hash value: 123", nodes: [] };
    mocks.getExplainInfo.mockResolvedValue("Plan hash value: 123");
    mocks.parseOracleExplainText.mockReturnValue(parsedPlan);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.explainTabSql(tabId, "SELECT * FROM DUAL", "oracle");

    expect(mocks.parseOracleExplainText).toHaveBeenCalledWith("Plan hash value: 123");
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      explainPlan: parsedPlan,
      explainSql: "EXPLAIN PLAN FOR SELECT * FROM DUAL",
      explainError: undefined,
    });
  });
});
