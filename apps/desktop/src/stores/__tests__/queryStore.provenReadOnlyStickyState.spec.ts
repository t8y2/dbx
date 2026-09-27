import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  beginManualTransaction: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  commitManualTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  executeMulti: vi.fn(),
  getConnectionConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  rollbackManualTransaction: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  beginManualTransaction: mocks.beginManualTransaction,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  commitManualTransaction: mocks.commitManualTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  executeMulti: mocks.executeMulti,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
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

type StickyResult = Record<string, unknown>;

function cleanSelect(): StickyResult[] {
  return [{ columns: ["VALUE"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, manual_transaction_proven_read_only: true }];
}

function dirtyUpdate(): StickyResult[] {
  return [{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }];
}

function noOpResult(): StickyResult[] {
  return [{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, manual_transaction_no_statement: true }];
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

describe("queryStore Oracle/OceanBase manual-transaction sticky state (behavior frozen)", () => {
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

  async function setupManualTab(store: { createTab: (c: string, d: string, t: string, m: string, s: string) => string }, _sql = "SELECT * FROM EMP") {
    mocks.beginManualTransaction.mockResolvedValue("txn-oracle");
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);
    return tabId;
  }

  it("starts one session for a result-grid save before the next SQL execution", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    const sessionId = await store.ensureManualTransactionSession(tabId, "ORCL", "APP");
    expect(sessionId).toBe("txn-oracle");
    expect(mocks.beginManualTransaction).toHaveBeenCalledWith("oracle-1", "ORCL", "APP", undefined);
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBe("txn-oracle");
    await store.ensureManualTransactionSession(tabId, "ORCL", "APP");
    expect(mocks.beginManualTransaction).toHaveBeenCalledOnce();
  });

  it("rolls back a session opened after the tab leaves manual mode", async () => {
    let finishBegin!: (sessionId: string) => void;
    mocks.beginManualTransaction.mockReturnValue(
      new Promise<string>((resolve) => {
        finishBegin = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query", "APP");
    store.setAutoCommit(tabId, false);

    const starting = store.ensureManualTransactionSession(tabId, "ORCL", "APP");
    store.setAutoCommit(tabId, true);
    finishBegin("txn-late");

    await expect(starting).rejects.toThrow("Query tab changed");
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-late");
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBeUndefined();
  });

  it("rolls back a session opened for a database the tab has left", async () => {
    let finishBegin!: (sessionId: string) => void;
    mocks.beginManualTransaction.mockReturnValue(
      new Promise<string>((resolve) => {
        finishBegin = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query");
    store.setAutoCommit(tabId, false);

    const starting = store.ensureManualTransactionSession(tabId, "ORCL");
    store.updateDatabase(tabId, "OTHER_DB");
    finishBegin("txn-old-database");

    await expect(starting).rejects.toThrow("Query tab changed");
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-old-database");
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBeUndefined();
  });

  it("does not attach a pending session after leaving and returning to the same database", async () => {
    let finishBegin!: (sessionId: string) => void;
    mocks.beginManualTransaction.mockReturnValue(
      new Promise<string>((resolve) => {
        finishBegin = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query");
    store.setAutoCommit(tabId, false);

    const starting = store.ensureManualTransactionSession(tabId, "ORCL");
    store.updateDatabase(tabId, "OTHER_DB");
    store.updateDatabase(tabId, "ORCL");
    finishBegin("txn-before-switch");

    await expect(starting).rejects.toThrow("Query tab changed");
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-before-switch");
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBeUndefined();
  });

  it("rolls back a session opened for a catalog the tab has left", async () => {
    let finishBegin!: (sessionId: string) => void;
    mocks.beginManualTransaction.mockReturnValue(
      new Promise<string>((resolve) => {
        finishBegin = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query");
    store.setAutoCommit(tabId, false);

    const starting = store.ensureManualTransactionSession(tabId, "ORCL");
    store.updateCatalog(tabId, "NEW_CATALOG", "ORCL");
    finishBegin("txn-old-catalog");

    await expect(starting).rejects.toThrow("Query tab changed");
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-old-catalog");
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBeUndefined();
  });

  it("does not reuse a previous database's transaction while rollback is pending", async () => {
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockResolvedValueOnce("txn-new");
    mocks.rollbackManualTransaction.mockReturnValueOnce(new Promise<void>(() => {}));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query", "query");
    store.setAutoCommit(tabId, false);
    await store.ensureManualTransactionSession(tabId, "ORCL");

    store.updateDatabase(tabId, "OTHER_DB");
    const newSession = await store.ensureManualTransactionSession(tabId, "OTHER_DB");

    expect(newSession).toBe("txn-new");
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-old");
    expect(mocks.beginManualTransaction).toHaveBeenNthCalledWith(2, "oracle-1", "OTHER_DB", undefined, undefined);
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBe("txn-new");
  });

  it("sends classificationSql only for the initial Oracle manual execution", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    expect(mocks.executeInManualTransaction).toHaveBeenCalledOnce();
    const args = mocks.executeInManualTransaction.mock.calls[0]!;
    expect(args[0]).toBe("txn-oracle");
    // classificationSql is the last argument of the non-cursor branch.
    expect(args.at(-1)).toBe("SELECT * FROM EMP");
  });

  it("keeps a clean Oracle manual session clean after a proven simple SELECT", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).not.toBe(true);
    expect(tab.txnSessionId).toBe("txn-oracle");
  });

  it("dirties an Oracle manual session after an UPDATE", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(dirtyUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("marks an Oracle manual session dirty when the result grid dispatches a mutation", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);
    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    store.markManualTransactionDirty(tabId);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("never clears the sticky state after a later read (UPDATE -> SELECT)", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(dirtyUpdate()).mockResolvedValueOnce(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");
    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("dirties the session for any unproven statement in a mixed script", async () => {
    mocks.executeInManualTransaction.mockResolvedValue([
      { columns: ["VALUE"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, manual_transaction_proven_read_only: true },
      { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "SELECT * FROM DUAL; DELETE FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("treats a Core no-op result as neither dirty nor clean-changing", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(noOpResult()).mockResolvedValueOnce(noOpResult());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    // Empty script keeps dirty undefined; then a real clean select still stays clean.
    await store.executeTabSql(tabId, "  -- only a comment\n");
    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).not.toBe(true);
  });

  it("passes no classificationSql and changes no sticky state on a cursor-page fetch", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(dirtyUpdate()).mockResolvedValueOnce(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");

    // Simulate a later page fetch of a clean result.
    mocks.executeInManualTransaction.mockClear();
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());
    await store.executeTabSql(tabId, "SELECT * FROM EMP", {
      pagination: { sessionId: "cursor-1", clientSessionId: "client-1", limit: 100, offset: 100 },
    });

    const args = mocks.executeInManualTransaction.mock.calls[0]!;
    // Page fetch carries no classificationSql (last argument), so it cannot
    // change the sticky bit.
    expect(args.at(-1)).toBeUndefined();
    const tab = store.tabs.find((item) => item.id === tabId)!;
    // Page fetch must neither set nor clear the dirty bit.
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("resets the sticky state on session-expiry recovery and recomputes from the retry", async () => {
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockResolvedValueOnce("txn-new");
    mocks.executeInManualTransaction.mockResolvedValueOnce(dirtyUpdate()).mockRejectedValueOnce(expiredTransactionError()).mockResolvedValueOnce(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");
    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnSessionId).toBe("txn-new");
    expect(tab.txnPossiblyDirty).not.toBe(true);
  });

  it("does not replay an expired transaction's SQL after its database changes during recovery", async () => {
    let finishBegin!: (sessionId: string) => void;
    mocks.beginManualTransaction.mockResolvedValueOnce("txn-old").mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishBegin = resolve;
        }),
    );
    mocks.executeInManualTransaction.mockRejectedValueOnce(expiredTransactionError()).mockResolvedValueOnce(cleanSelect());
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    const running = store.executeTabSql(tabId, "SELECT * FROM EMP");
    await vi.waitFor(() => expect(mocks.beginManualTransaction).toHaveBeenCalledTimes(2));
    store.updateDatabase(tabId, "OTHER_DB");
    finishBegin("txn-recovered-old-database");
    await running;

    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("txn-recovered-old-database");
    expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(1);
    expect(store.tabs.find((item) => item.id === tabId)?.txnSessionId).toBeUndefined();
    expect(store.tabs.find((item) => item.id === tabId)?.result).toBeUndefined();
  });

  it("does not publish results from a database the tab has left", async () => {
    let finishQuery!: (results: StickyResult[]) => void;
    mocks.executeInManualTransaction.mockReturnValueOnce(
      new Promise<StickyResult[]>((resolve) => {
        finishQuery = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    const running = store.executeTabSql(tabId, "SELECT * FROM EMP");
    await vi.waitFor(() => expect(mocks.executeInManualTransaction).toHaveBeenCalledTimes(1));
    store.updateDatabase(tabId, "OTHER_DB");
    finishQuery(cleanSelect());
    await running;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.database).toBe("OTHER_DB");
    expect(tab.result).toBeUndefined();
    expect(tab.isExecuting).toBe(false);
  });

  it("clears the sticky state together with the session on DBX rollback", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(dirtyUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");
    await store.rollbackTransaction(tabId);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.txnPossiblyDirty).not.toBe(true);
  });

  it("clears session and sticky state when a statement failure disposes the manual session", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(dirtyUpdate()).mockRejectedValueOnce(new Error("Statement 1 failed: ORA-02292 integrity constraint violated. The manual transaction was rolled back."));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");
    await store.executeTabSql(tabId, "DELETE FROM EMP WHERE DEPTNO = 99");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    // The `rolled back` fragment is the cleanup compatibility contract: the
    // backend removed the manual session, so both fields must reset with it.
    expect(tab.txnSessionId).toBeUndefined();
    expect(tab.txnPossiblyDirty).not.toBe(true);
    expect(tab.txnAutoRolledBack).not.toBe(true);
  });

  it("dirties a clean session when a frontend timeout rejects while the manual session survives", async () => {
    mocks.executeInManualTransaction.mockRejectedValueOnce(new Error("Query timed out after 30 seconds"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    // The statement may still have executed server-side while the manual
    // session survives, so the sticky state must stay fail-closed dirty.
    expect(tab.txnSessionId).toBe("txn-oracle");
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("keeps a clean session clean when a cursor-page fetch times out", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(cleanSelect()).mockRejectedValueOnce(new Error("Query timed out after 30 seconds"));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "SELECT * FROM EMP");
    await store.executeTabSql(tabId, "SELECT * FROM EMP", {
      pagination: { sessionId: "cursor-1", clientSessionId: "client-1", limit: 100, offset: 100 },
    });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    // Page fetches never participate in the sticky state, matching aggregation.
    expect(tab.txnSessionId).toBe("txn-oracle");
    expect(tab.txnPossiblyDirty).not.toBe(true);
  });

  it("keeps the legacy toolbar rule for dialects without sticky state", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "jdbc-1",
      name: "JDBC",
      db_type: "jdbc",
      database: "appdb",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockResolvedValue("txn-jdbc");
    mocks.executeInManualTransaction.mockResolvedValue([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-1", "appdb", "Query", "query", "main");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1");
    store.markManualTransactionDirty(tabId);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    // No classificationSql is sent and no sticky state exists for non-sticky
    // dialects: commit/rollback follow the legacy always-visible rule.
    const args = mocks.executeInManualTransaction.mock.calls[0]!;
    expect(args.at(-1)).toBeUndefined();
    expect(tab.txnPossiblyDirty).toBeUndefined();
    expect(tab.txnSessionId).toBe("txn-jdbc");
  });
});

describe.each([
  { label: "MySQL", configId: "mysql-1", database: "test", dbType: "mysql", txnId: "txn-mysql" },
  { label: "PostgreSQL", configId: "pg-1", database: "postgres", dbType: "postgres", txnId: "txn-pg" },
])("queryStore $label proven-read-only sticky state", ({ configId, database, dbType, txnId }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConnectionConfig.mockReturnValue({
      id: configId,
      name: dbType,
      db_type: dbType,
      database,
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
    mocks.beginManualTransaction.mockResolvedValue(txnId);
  });

  async function setupStickyManualTab(store: { createTab: (c: string, d: string, t: string, m: string, s: string) => string }) {
    const tabId = store.createTab(configId, database, "Query", "query", "APP");
    store.setAutoCommit(tabId, false);
    return tabId;
  }

  it("sends classificationSql for the initial manual execution and stays clean on a proven read", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupStickyManualTab(store);

    await store.executeTabSql(tabId, "SELECT * FROM users");

    const args = mocks.executeInManualTransaction.mock.calls[0]!;
    expect(args.at(-1)).toBe("SELECT * FROM users");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).not.toBe(true);
    expect(tab.txnSessionId).toBe(txnId);
  });

  it("dirties the session after an unproven statement", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(dirtyUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupStickyManualTab(store);

    await store.executeTabSql(tabId, "UPDATE users SET name = 'x'");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });

  it("keeps a comment-only script from dirtying the session (core no-op)", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(noOpResult());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupStickyManualTab(store);

    await store.executeTabSql(tabId, "  -- only a comment\n");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).not.toBe(true);
  });

  it("marks the session dirty when the result grid dispatches a mutation", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupStickyManualTab(store);
    await store.executeTabSql(tabId, "SELECT * FROM users");

    store.markManualTransactionDirty(tabId);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.txnPossiblyDirty).toBe(true);
  });
});
