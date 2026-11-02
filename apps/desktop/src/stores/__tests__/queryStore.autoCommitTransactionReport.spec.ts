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

type AutoCommitRolledBackTab = {
  autoCommitOpenTransaction?: boolean;
  autoCommitTxnRolledBack?: boolean;
  autoCommitSessionTxnRolledBack?: boolean;
  autoCommitSessionTxnRolledBackNotified?: boolean;
};

function emptyTab(): AutoCommitRolledBackTab {
  return {};
}

describe("applyAutoCommitTransactionReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("mirrors the open-transaction marker the backend reported", async () => {
    const { applyAutoCommitTransactionReport } = await import("@/stores/queryStore");
    const tab = emptyTab();
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_open_transaction: true }] as never);
    expect(tab.autoCommitOpenTransaction).toBe(true);
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_open_transaction: false }] as never);
    expect(tab.autoCommitOpenTransaction).toBe(false);
  });

  it("keeps reporting an explicitly opened transaction that was rolled back", async () => {
    const { applyAutoCommitTransactionReport } = await import("@/stores/queryStore");
    const tab = emptyTab();
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_explicit_transaction_rolled_back: true }] as never);
    expect(tab.autoCommitTxnRolledBack).toBe(true);

    // The user dismisses the notice; the next execution that rolls back another
    // explicit transaction must raise it again — the tab lost real work.
    tab.autoCommitTxnRolledBack = false;
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_explicit_transaction_rolled_back: true }] as never);
    expect(tab.autoCommitTxnRolledBack).toBe(true);
  });

  it("reports a session-level implicit rollback once per connection", async () => {
    const { applyAutoCommitTransactionReport } = await import("@/stores/queryStore");
    const tab = emptyTab();
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_session_autocommit_rolled_back: true }] as never);
    expect(tab.autoCommitSessionTxnRolledBack).toBe(true);
    expect(tab.autoCommitTxnRolledBack).toBeUndefined();

    // `SET autocommit = 0` rolls back an implicit transaction after *every*
    // execution; dismissing the notice must not bring it straight back.
    tab.autoCommitSessionTxnRolledBack = false;
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_session_autocommit_rolled_back: true }] as never);
    expect(tab.autoCommitSessionTxnRolledBack).toBe(false);

    // Auto-commit is back on (or the execution never used the tab connection):
    // the next auto-commit-off session is reported again.
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_open_transaction: false }] as never);
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_session_autocommit_rolled_back: true }] as never);
    expect(tab.autoCommitSessionTxnRolledBack).toBe(true);
  });

  it("prefers the explicit notice when a batch carries both markers", async () => {
    const { applyAutoCommitTransactionReport } = await import("@/stores/queryStore");
    const tab = emptyTab();
    applyAutoCommitTransactionReport(tab as never, [{ auto_commit_explicit_transaction_rolled_back: true, auto_commit_session_autocommit_rolled_back: true }] as never);
    expect(tab.autoCommitTxnRolledBack).toBe(true);
    expect(tab.autoCommitSessionTxnRolledBack).toBeUndefined();
  });
});

describe("auto-commit tab transaction actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      database: "dbx",
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
    mocks.executeMulti.mockResolvedValue({
      results: [{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1, auto_commit_open_transaction: false }],
    });
  });

  async function setupAutoCommitTabWithKeptTransaction() {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");
    const tab = store.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error("tab missing");
    // The backend reported a kept explicit transaction on this tab connection.
    tab.autoCommitOpenTransaction = true;
    tab.autoCommitSessionTxnRolledBack = true;
    tab.autoCommitSessionTxnRolledBackNotified = true;
    return { store, tabId, tab };
  }

  it("commits a kept auto-commit transaction as an ordinary statement", async () => {
    const { store, tabId } = await setupAutoCommitTabWithKeptTransaction();
    await store.commitTransaction(tabId);

    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("COMMIT");
  });

  it("rolls back a kept auto-commit transaction as an ordinary statement", async () => {
    const { store, tabId } = await setupAutoCommitTabWithKeptTransaction();
    await store.rollbackTransaction(tabId);

    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("ROLLBACK");
  });

  it("drops the session-level notice when the tab switches connection", async () => {
    const { store, tabId, tab } = await setupAutoCommitTabWithKeptTransaction();
    store.updateConnection(tabId, "mysql-2", "dbx");

    expect(tab.autoCommitSessionTxnRolledBack).toBeUndefined();
    expect(tab.autoCommitSessionTxnRolledBackNotified).toBeUndefined();
  });
});
