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
    editorSettings: { pageSize: 100, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false },
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
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalled());
  });

  it("keeps the tab on its database when the USE statement fails", async () => {
    mocks.executeMulti.mockResolvedValue([{ ...okResult, execution_error: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "dbx", "Query", "query");

    await store.executeTabSql(tabId, "USE missing_db;");

    expect(store.tabs.find((tab) => tab.id === tabId)?.database).toBe("dbx");
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
