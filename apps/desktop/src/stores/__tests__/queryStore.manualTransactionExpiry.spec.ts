import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  beginManualTransaction: vi.fn(),
  commitManualTransaction: vi.fn(),
  rollbackManualTransaction: vi.fn(),
  cancelQueryAndWait: vi.fn(),
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
  commitManualTransaction: mocks.commitManualTransaction,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
  cancelQueryAndWait: mocks.cancelQueryAndWait,
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

function successfulReadOnlySelect() {
  return [{ columns: ["VALUE"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, manual_transaction_proven_read_only: true }];
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

  it("restarts an expired read-only transaction without the rollback notice", async () => {
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockResolvedValueOnce("txn-new");
    mocks.executeInManualTransaction.mockResolvedValueOnce(successfulReadOnlySelect()).mockRejectedValueOnce(expiredTransactionError()).mockResolvedValueOnce(successfulReadOnlySelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT VALUE FROM DUAL");
    await store.executeTabSql(tabId, "SELECT VALUE FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnSessionId).toBe("txn-new");
    expect(tab.result?.rows).toEqual([[1]]);
    // 只读会话没有任何未提交改动，空闲回收后静默重建即可，不应提示「事务已自动回滚」(#9831)
    expect(tab.txnAutoRolledBack).not.toBe(true);
  });

  it("keeps the rollback notice for a manual dialect without sticky read-only tracking", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "dameng-1",
      name: "DM",
      db_type: "dameng",
      database: "DMHR",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockResolvedValueOnce("txn-new");
    mocks.executeInManualTransaction.mockResolvedValueOnce(successfulSelect()).mockRejectedValueOnce(expiredTransactionError()).mockResolvedValueOnce(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("dameng-1", "DMHR", "Query", "query", "SYSDBA");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnSessionId).toBe("txn-new");
    expect(tab.result?.rows).toEqual([[1]]);
    // 不跟踪只读状态的方言无法判断会话是否干净，保留原有提示。
    expect(tab.txnAutoRolledBack).toBe(true);
  });

  it("normalizes a stale manual tab for a non-transactional database before query dispatch", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "sqlite-1",
      name: "SQLite",
      db_type: "sqlite",
      database: "main",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): Unknown method: begin_manual_transaction"));
    mocks.executeMulti.mockResolvedValue(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlite-1", "main", "Query", "query", "main");
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

  it.each(["oracle", "oceanbase-oracle"] as const)("does not fall back to auto-commit when a supported %s manual transaction fails to begin", async (databaseType) => {
    mocks.beginManualTransaction.mockRejectedValue(new Error("manual transaction begin failed"));
    mocks.executeMulti.mockResolvedValue(successfulSelect());
    mocks.getConnectionConfig.mockReturnValue({
      id: `${databaseType}-1`,
      name: databaseType,
      db_type: databaseType,
      database: "ORCL",
      query_timeout_secs: 30,
    });

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab(`${databaseType}-1`, "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(false);
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.result?.execution_error).toBe(true);
  });

  it("falls back to auto-commit for a read query when an old Oracle Agent lacks manual transactions", async () => {
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): unknown method: begin_manual_transaction"));
    mocks.executeMulti.mockResolvedValue(successfulSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
    expect(tab.txnSessionId).toBeUndefined();
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(tab.result?.rows).toEqual([[1]]);
  });

  it("does not replay a write when an old Oracle Agent lacks manual transactions", async () => {
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): Method not found: begin_manual_transaction"));
    mocks.executeMulti.mockResolvedValue(successfulUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "UPDATE USERS SET ACTIVE = 1");

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

  it("surfaces ordinary query failures after normalizing a stale non-transactional tab", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "sqlite-1",
      name: "SQLite",
      db_type: "sqlite",
      database: "main",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockRejectedValue(new Error("BEGIN manual transaction failed: Agent RPC error (-1): Unknown method: begin_manual_transaction"));
    mocks.executeMulti.mockRejectedValue(new Error("SQLite query failed"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlite-1", "main", "Query", "query", "main");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT missing_column FROM DUAL");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.autoCommit).toBe(true);
    expect(mocks.beginManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(tab.result?.execution_error).toBe(true);
  });

  async function sqlServerTab() {
    mocks.getConnectionConfig.mockReturnValue({ id: "sqlserver-1", name: "SQL Server", db_type: "sqlserver", database: "db", query_timeout_secs: 30 });
    mocks.rollbackManualTransaction.mockResolvedValue({ columns: [], rows: [] });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("sqlserver-1", "db", "SQL", "query", "dbo");
    store.setAutoCommit(id, false);
    return { store, id, tab: store.tabs.find((tab) => tab.id === id)! };
  }

  function transactionError(code: string, outcome: "unknown" | "rolled_back" | "committed" = "unknown") {
    return { ...expiredTransactionError(), code, messageKey: code === "DBX-TXN-1007" ? "backendErrors.transaction.commitUnknown" : "backendErrors.transaction.connectionLost", transactionOutcome: outcome };
  }

  it("SQL Server retains one session across executions and forwards cancellation identity and timeout", async () => {
    const { store, id, tab } = await sqlServerTab();
    mocks.beginManualTransaction.mockResolvedValue("sqlserver-txn-fixed");
    mocks.executeInManualTransaction.mockResolvedValue(successfulUpdate());
    await store.executeTabSql(id, "UPDATE users SET active = 1");
    await store.executeTabSql(id, "UPDATE users SET active = 2");
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(2);
    for (const call of mocks.executeInManualTransaction.mock.calls) {
      expect(call[0]).toBe("sqlserver-txn-fixed");
      expect(call[9]).toEqual(expect.any(String));
      expect(call[10]).toBe(30);
    }
    expect(tab.txnStatus).toBe("active");
    expect(tab.autoCommit).toBe(false);
  });

  it.each([expiredTransactionError(), transactionError("DBX-TXN-1005"), transactionError("DBX-TXN-1009", "rolled_back")])("SQL Server never silently replays a failed execution (%s)", async (error) => {
    const { store, id, tab } = await sqlServerTab();
    mocks.beginManualTransaction.mockResolvedValueOnce("sqlserver-txn-old").mockResolvedValueOnce("sqlserver-txn-new");
    mocks.executeInManualTransaction.mockRejectedValueOnce(error).mockResolvedValueOnce(successfulUpdate());
    await store.executeTabSql(id, "UPDATE users SET active = 1");
    expect(mocks.executeInManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.autoCommit).toBe(false);
    expect(tab.txnAutoRolledBack).toBe(false);
    expect(tab.result?.execution_error).toBe(true);
    await store.executeTabSql(id, "UPDATE users SET active = 2");
    expect(mocks.beginManualTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(2);
    expect(tab.txnSessionId).toBe("sqlserver-txn-new");
  });

  it("SQL Server refuses unsupported BEGIN even for a read without automatic execution", async () => {
    const { store, id, tab } = await sqlServerTab();
    mocks.beginManualTransaction.mockRejectedValueOnce(new Error("Unknown method: begin_manual_transaction"));
    await store.executeTabSql(id, "SELECT 1");
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.autoCommit).toBe(false);
    expect(tab.result?.execution_error).toBe(true);
  });

  it("SQL Server clears a lost commit session, reports unknown and never retries commit", async () => {
    const { store, id, tab } = await sqlServerTab();
    tab.txnSessionId = "sqlserver-txn-commit";
    mocks.commitManualTransaction.mockRejectedValueOnce(transactionError("DBX-TXN-1007"));
    await store.commitTransaction(id);
    expect(mocks.commitManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    expect(tab.txnStatus).toBe("unknown");
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.autoCommit).toBe(false);
  });

  it("SQL Server refuses switching to auto commit when rollback is unconfirmed", async () => {
    const { store, id, tab } = await sqlServerTab();
    tab.txnSessionId = "sqlserver-txn-rollback";
    mocks.rollbackManualTransaction.mockRejectedValueOnce(transactionError("DBX-TXN-1006"));
    store.setAutoCommit(id, true);
    await vi.waitFor(() => expect(tab.txnStatus).toBe("lost"));
    expect(tab.autoCommit).toBe(false);
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.txnAutoRolledBack).toBe(false);
  });

  it("SQL Server preserves the transaction handle on a busy rollback rejection", async () => {
    const { store, id, tab } = await sqlServerTab();
    tab.txnSessionId = "sqlserver-txn-busy";
    mocks.rollbackManualTransaction.mockRejectedValueOnce(transactionError("DBX-TXN-1003"));
    await store.rollbackTransaction(id);
    expect(tab.txnSessionId).toBe("sqlserver-txn-busy");
    expect(tab.txnStatus).toBe("active");
  });

  it("SQL Server keeps manual mode while cancellation is not terminal", async () => {
    const { store, id, tab } = await sqlServerTab();
    tab.txnSessionId = "sqlserver-txn-running";
    tab.isExecuting = true;
    tab.executionId = "running-id";
    mocks.cancelQueryAndWait.mockResolvedValueOnce({ requested: true, terminal: false });
    store.setAutoCommit(id, true);
    await vi.waitFor(() => expect(mocks.cancelQueryAndWait).toHaveBeenCalledWith("running-id"));
    await Promise.resolve();
    expect(tab.autoCommit).toBe(false);
    expect(tab.txnSessionId).toBe("sqlserver-txn-running");
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
  });

  it("SQL Server treats a lost desktop commit response as unknown even without a backend envelope", async () => {
    const { store, id, tab } = await sqlServerTab();
    tab.txnSessionId = "sqlserver-txn-transport";
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("IPC response lost"));
    await store.commitTransaction(id);
    expect(tab.txnStatus).toBe("unknown");
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.txnNotice).toContain("COMMIT");
    expect(mocks.commitManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
  });

  it.each(["database", "close"])("SQL Server cleans a late BEGIN after a %s change without dispatching SQL", async (action) => {
    const { store, id, tab } = await sqlServerTab();
    let finishBegin!: (session: string) => void;
    mocks.beginManualTransaction.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishBegin = resolve;
      }),
    );
    const execution = store.executeTabSql(id, "UPDATE users SET active = 1");
    await vi.waitFor(() => expect(mocks.beginManualTransaction).toHaveBeenCalledOnce());
    if (action === "database") store.updateDatabase(id, "other_database");
    else store.closeTab(id, { force: true });
    finishBegin("sqlserver-txn-late");
    await execution;
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledOnce();
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("sqlserver-txn-late");
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.txnSessionId).toBeUndefined();
  });
});
