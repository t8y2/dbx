import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  executeMulti: vi.fn(),
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  saveOpenTabsState: vi.fn(),
  preparePaginationPlan: vi.fn(),
  getConfig: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  executeQuery: mocks.executeQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  saveOpenTabsState: mocks.saveOpenTabsState,
  prepareQueryPaginationExecutionPlan: mocks.preparePaginationPlan,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
    ensureConnected: mocks.ensureConnected,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false, keepExplicitTransactionInAutoCommit: true },
  }),
}));

const okResult: QueryResult = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 };

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore USE database statement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", query_timeout_secs: 45 });
    mocks.executeMulti.mockResolvedValue([okResult]);
    mocks.executeQuery.mockResolvedValue(okResult);
    mocks.closeClientConnectionSession.mockResolvedValue(true);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.preparePaginationPlan.mockImplementation(async (options: { sql: string }) => ({ sqlToExecute: options.sql }));
  });

  it("follows a successful USE statement in the tab's database", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");

    await store.executeTabSql(tabId, "USE dbx_dup;");

    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(store.tabs.find((tab) => tab.id === tabId)?.database).toBe("dbx_dup");
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    await store.executeTabSql(tabId, "SET @probe = 12345;");
    await store.executeTabSql(tabId, "SELECT @probe;");
    expect(mocks.executeMulti.mock.calls.map((call) => call[1])).toEqual(["dbx", "dbx_dup", "dbx_dup"]);
    expect(new Set(mocks.executeMulti.mock.calls.map((call) => call[5].clientSessionId)).size).toBe(1);
  });

  it("keeps the tab on its database when the USE statement fails", async () => {
    mocks.executeMulti.mockResolvedValue([{ ...okResult, execution_error: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");

    await store.executeTabSql(tabId, "USE missing_db;");

    expect(store.tabs.find((tab) => tab.id === tabId)?.database).toBe("dbx");
  });

  it("keeps an explicit transaction reachable across USE and toolbar database changes", async () => {
    mocks.executeMulti.mockResolvedValue([{ ...okResult, auto_commit_open_transaction: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");
    const tab = store.tabs.find((entry) => entry.id === tabId)!;
    await store.executeTabSql(tabId, "/* begin */ START TRANSACTION;");
    await store.executeTabSql(tabId, "USE dbx_dup;");
    expect(tab.autoCommitOpenTransaction).toBe(true);
    store.updateDatabase(tabId, "dbx");
    expect(tab.autoCommitOpenTransaction).toBe(true);
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    mocks.executeMulti.mockResolvedValue([{ ...okResult, auto_commit_open_transaction: false }]);
    await store.executeTabSql(tabId, "COMMIT;");
    expect(tab.autoCommitOpenTransaction).toBe(false);
    expect(mocks.executeMulti.mock.calls.every((call) => call[5].preserveExplicitTransaction)).toBe(true);
  });

  it.each([false, true])("clears the old transaction when a lost physical session is reported (throws=%s)", async (throws) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");
    const tab = store.tabs.find((entry) => entry.id === tabId)!;
    tab.autoCommitOpenTransaction = true;
    const message = "MYSQL_CLIENT_SESSION_LOST: The original session was lost";
    if (throws) mocks.executeMulti.mockRejectedValue(new Error(message));
    else mocks.executeMulti.mockResolvedValue([{ ...okResult, execution_error: true, columns: ["Error"], rows: [[message]] }]);
    await store.executeTabSql(tabId, "COMMIT;");
    expect(tab.autoCommitOpenTransaction).toBe(false);
    expect(tab.result?.execution_error).toBe(true);
    expect(JSON.stringify(tab.result?.rows)).toContain("MYSQL_CLIENT_SESSION_LOST");
  });

  it.each([false, true])("does not clear a newer transaction when an older request reports a lost session (throws=%s)", async (throws) => {
    let finish!: (results: QueryResult[]) => void;
    let reject!: (error: Error) => void;
    mocks.executeMulti.mockReturnValue(
      new Promise((resolve, fail) => {
        finish = resolve;
        reject = fail;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "dbx", "Query", "query");
    const pending = store.executeTabSql(id, "COMMIT");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalled());
    const tab = store.tabs.find((entry) => entry.id === id)!;
    tab.executionId = "newer-execution";
    tab.autoCommitOpenTransaction = true;
    if (throws) reject(new Error("MYSQL_CLIENT_SESSION_LOST: old session"));
    else finish([{ ...okResult, execution_error: true, auto_commit_open_transaction: false, columns: ["Error"], rows: [["MYSQL_CLIENT_SESSION_LOST: old session"]] }]);
    await pending;
    expect(tab.autoCommitOpenTransaction).toBe(true);
  });

  it("does not let a pending USE overwrite a newer toolbar database selection", async () => {
    let finish!: (results: QueryResult[]) => void;
    mocks.executeMulti.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "dbx", "Query", "query");
    const tab = store.tabs.find((entry) => entry.id === id)!;
    tab.autoCommitOpenTransaction = true;
    const pending = store.executeTabSql(id, "USE earlier_database");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalled());
    store.updateDatabase(id, "latest_database");
    finish([{ ...okResult, auto_commit_open_transaction: true }]);
    await pending;
    expect(tab.database).toBe("latest_database");
    expect(tab.autoCommitOpenTransaction).toBe(true);
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("does not follow USE for dialects where it is not a database switch", async () => {
    mocks.getConfig.mockReturnValue({ id: "pg-1", name: "PostgreSQL", db_type: "postgres", query_timeout_secs: 45 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "public_db", "Query", "query");

    await store.executeTabSql(tabId, "USE other_db;");

    expect(store.tabs.find((tab) => tab.id === tabId)?.database).toBe("public_db");
  });
});
