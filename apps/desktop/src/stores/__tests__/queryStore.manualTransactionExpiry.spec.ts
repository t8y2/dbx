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

function successfulSelect() {
  return [{ columns: ["VALUE"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }];
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

  it("normalizes a stale manual OceanBase tab before query dispatch", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oceanbase-1",
      name: "OceanBase Oracle",
      db_type: "oceanbase-oracle",
      database: "SYS",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): Unknown method: begin_manual_transaction"));
    mocks.executeMulti.mockResolvedValue(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oceanbase-1", "SYS", "Query", "query", "SYS");
    // Simulate a manual-mode value restored from an older saved query tab.
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
    expect(mocks.beginManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(tab.result?.rows).toEqual([[1]]);
    expect(tab.result?.execution_error).not.toBe(true);
  });

  it("does not fall back to auto-commit when a supported manual transaction fails to begin", async () => {
    mocks.beginManualTransaction.mockRejectedValue(new Error("manual transaction begin failed"));
    mocks.executeMulti.mockResolvedValue(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(false);
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.result?.execution_error).toBe(true);
  });

  it("keeps raw JDBC connections in manual mode when their effective dialect is unsupported", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "jdbc-1",
      name: "Databend JDBC",
      db_type: "jdbc",
      database: "default",
      connection_string: "jdbc:databend://localhost:8000/default",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockResolvedValue("txn-jdbc");
    mocks.executeInManualTransaction.mockResolvedValue(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-1", "default", "Query", "query", "analytics");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(false);
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("surfaces ordinary query failures after normalizing a stale OceanBase tab", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oceanbase-1",
      name: "OceanBase Oracle",
      db_type: "oceanbase-oracle",
      database: "SYS",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): Unknown method: begin_manual_transaction"));
    mocks.executeMulti.mockRejectedValue(new Error("OceanBase query failed"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oceanbase-1", "SYS", "Query", "query", "SYS");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT missing_column FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
    expect(mocks.beginManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(tab.result?.execution_error).toBe(true);
  });
});
