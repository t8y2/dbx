import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  beginManualTransaction: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  executeInManualTransaction: vi.fn(),
  executeMulti: vi.fn(),
  getConnectionConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  beginManualTransaction: mocks.beginManualTransaction,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeInManualTransaction: mocks.executeInManualTransaction,
  executeMulti: mocks.executeMulti,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

// The in-memory editor settings are mutated per test so a fresh tab reflects the
// configured default transaction mode. Missing key falls back to auto-commit.
const editorSettings: Record<string, unknown> = {
  autoCalculateTotalRows: false,
  continueOnErrorOnBatch: false,
  pageSize: 100,
  queryResultMaxRowsEnabled: false,
  queryResultMaxRows: 1000,
  openTabsRestoreMode: "all",
  confirmUnsavedSqlClose: false,
};

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings }),
}));

describe("queryStore default transaction mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mocks.getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
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
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "not-select" });
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    delete editorSettings.defaultTransactionMode;
  });

  it("creates a query tab in manual transaction mode when configured", async () => {
    editorSettings.defaultTransactionMode = "manual";

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(false);
  });

  it("creates a query tab in auto-commit mode by default", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
  });

  it("creates a query tab in auto-commit mode when explicitly set to auto", async () => {
    editorSettings.defaultTransactionMode = "auto";

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
  });
});
