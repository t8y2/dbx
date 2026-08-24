import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  beginManualTransaction: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  executeInManualTransaction: vi.fn(),
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

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      autoCalculateTotalRows: false,
      continueOnErrorOnBatch: false,
      pageSize: 100,
      queryResultMaxRowsEnabled: false,
      queryResultMaxRows: 1000,
      openTabsRestoreMode: "all",
      confirmUnsavedSqlClose: false,
    },
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

function expiredTransactionError() {
  return {
    version: 1 as const,
    code: "DBX-TXN-1001",
    messageKey: "backendErrors.transaction.sessionExpired",
    messageParams: { timeoutSecs: 300 },
    source: "legacyBackend" as const,
    operationOutcome: "not_started" as const,
    origin: { subsystem: "database", adapter: "native" },
    diagnostics: { category: "transaction", stage: "execute" },
  };
}

function successfulUpdate() {
  return [{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }];
}

describe("queryStore manual transaction expiry recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
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
  });

  it("restarts an expired transaction and retries the SQL exactly once", async () => {
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockResolvedValueOnce("txn-new");
    mocks.executeInManualTransaction.mockResolvedValueOnce(successfulUpdate()).mockRejectedValueOnce(expiredTransactionError()).mockResolvedValueOnce(successfulUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    // Tabs default to auto-commit; the expiry recovery path only applies to manual transactions.
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "UPDATE USERS SET ACTIVE = 1");
    await store.executeTabSql(tabId, "UPDATE USERS SET ACTIVE = 1");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.beginManualTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.executeInManualTransaction.mock.calls[1]?.[0]).toBe("txn-old");
    expect(mocks.executeInManualTransaction.mock.calls[2]?.[0]).toBe("txn-new");
    expect(tab.txnSessionId).toBe("txn-new");
    expect(tab.txnAutoRolledBack).toBe(true);
    expect(tab.result?.execution_error).not.toBe(true);
    expect(tab.result?.affected_rows).toBe(1);
  });
});
