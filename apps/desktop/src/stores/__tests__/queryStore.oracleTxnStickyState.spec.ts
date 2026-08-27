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

type OracleResult = Record<string, unknown>;

function cleanSelect(): OracleResult[] {
  return [{ columns: ["VALUE"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, manual_transaction_proven_read_only: true }];
}

function dirtyUpdate(): OracleResult[] {
  return [{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }];
}

function noOpResult(): OracleResult[] {
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

describe("queryStore Oracle manual-transaction sticky state", () => {
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
    expect(tab.txnSessionId).toBe("txn-oracle");
  });

  it("dirties an Oracle manual session after an UPDATE", async () => {
    mocks.executeInManualTransaction.mockResolvedValue(dirtyUpdate());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.oracleTxnPossiblyDirty).toBe(true);
  });

  it("never clears the sticky state after a later read (UPDATE -> SELECT)", async () => {
    mocks.executeInManualTransaction.mockResolvedValueOnce(dirtyUpdate()).mockResolvedValueOnce(cleanSelect());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = await setupManualTab(store);

    await store.executeTabSql(tabId, "UPDATE EMP SET DEPTNO = 10");
    await store.executeTabSql(tabId, "SELECT * FROM EMP");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.oracleTxnPossiblyDirty).toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).toBe(true);
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
    expect(tab.oracleTxnPossiblyDirty).not.toBe(true);
  });

  it("leaves non-Oracle manual sessions using the old rule and no marker handling", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "pg-1",
      name: "Postgres",
      db_type: "postgres",
      database: "postgres",
      query_timeout_secs: 30,
    });
    mocks.beginManualTransaction.mockResolvedValue("txn-pg");
    // A Postgres manual execution never returns the Oracle marker.
    mocks.executeInManualTransaction.mockResolvedValue([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "postgres", "Query", "query", "public");
    store.setAutoCommit(tabId, false);

    await store.executeTabSql(tabId, "SELECT 1");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    // No classificationSql was sent and no Oracle sticky state exists.
    const args = mocks.executeInManualTransaction.mock.calls[0]!;
    expect(args.at(-1)).toBeUndefined();
    expect(tab.oracleTxnPossiblyDirty).toBeUndefined();
    expect(tab.txnSessionId).toBe("txn-pg");
  });
});
