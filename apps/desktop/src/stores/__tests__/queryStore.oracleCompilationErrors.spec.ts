import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  executeQuery: vi.fn(),
  getConnectionConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
  clearDataGridPendingSnapshot: vi.fn(),
  clearDataGridPendingSnapshotsForTab: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  executeQuery: mocks.executeQuery,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { autoCalculateTotalRows: false, pageSize: 100, continueOnErrorOnBatch: false, defaultAutoKeepResults: false },
  }),
}));

vi.mock("@/composables/useDataGridEditor", () => ({
  clearDataGridPendingSnapshot: mocks.clearDataGridPendingSnapshot,
  clearDataGridPendingSnapshotsForTab: mocks.clearDataGridPendingSnapshotsForTab,
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

/** The 4th positional argument of executeMulti is the tab's schema. */
describe("Oracle compilation error reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({ id: "ora-1", name: "Oracle", db_type: "oracle", database: "FREEPDB1", query_timeout_secs: 30 });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.executeMultiWithProgress.mockImplementation(async (connectionId, database, sql, onProgress, schema, options) => {
      const results = await mocks.executeMulti(connectionId, database, sql, schema, options?.executionId, options);
      results.forEach((result: any, index: number) => {
        onProgress({
          executionId: options?.executionId,
          statementIndex: index,
          completed: index + 1,
          total: results.length,
          success: result.execution_error !== true,
          executionTimeMs: result.execution_time_ms,
          affectedRows: result.affected_rows,
          error: result.error,
        });
      });
      return results;
    });
  });

  it("asks the agent to report compilation errors for the Oracle SQL editor", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ora-1", "FREEPDB1", "Query", "query");
    await store.executeTabSql(tabId, "CREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;");

    expect(mocks.executeMulti.mock.lastCall?.[5]).toMatchObject({ reportCompilationErrors: true });
  });

  it("leaves the option off for Oracle reads", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("ora-1", "FREEPDB1", "Query", "query");
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");

    expect(mocks.executeMulti.mock.lastCall?.[5]).not.toHaveProperty("reportCompilationErrors");
  });

  it("leaves the option off for other databases", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "pg-1", name: "Postgres", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query", "query");
    await store.executeTabSql(tabId, "CREATE TABLE t (id INT)");

    expect(mocks.executeMulti.mock.lastCall?.[5]).not.toHaveProperty("reportCompilationErrors");
  });
});
