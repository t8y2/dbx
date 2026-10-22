import { computed } from "vue";
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
  getConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
  clearDataGridPendingSnapshot: vi.fn(),
  clearDataGridPendingSnapshotsForTab: vi.fn(),
  toast: vi.fn(),
  tabResultSnapshots: new Map<string, unknown>(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key, locale: { value: "en" } } }),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  buildSortedQuerySql: vi.fn(),
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  executeQuery: mocks.executeQuery,
  getColumns: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
  listIndexes: vi.fn(),
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
    recordConnectionLostError: vi.fn(),
    metadataGenerationFor: () => 0,
    lookupLocalCompletionTables: () => [],
    connectionIdentifierQuote: undefined,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      autoCalculateTotalRows: false,
      pageSize: 100,
      continueOnErrorOnBatch: false,
      defaultAutoKeepResults: false,
      infiniteScroll: false,
      queryResultMaxRowsEnabled: false,
      queryResultMaxRows: 10_000,
      tableOpenPageSize: 100,
      generateSqlIncludeDatabaseName: false,
    },
  }),
}));

vi.mock("@/composables/useDataGridEditor", () => ({
  clearDataGridPendingSnapshot: mocks.clearDataGridPendingSnapshot,
  clearDataGridPendingSnapshotsForTab: mocks.clearDataGridPendingSnapshotsForTab,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
  return {
    ...actual,
    writeTabResultSnapshot: vi.fn(async (key: string, snapshot: unknown) => {
      mocks.tabResultSnapshots.set(key, actual.decodeTabResultSnapshot(actual.encodeTabResultSnapshot(snapshot as Parameters<typeof actual.encodeTabResultSnapshot>[0])));
      return true;
    }),
    readTabResultSnapshot: vi.fn(async (key: string) => mocks.tabResultSnapshots.get(key)),
    deleteTabResultSnapshot: vi.fn(async (key: string) => {
      mocks.tabResultSnapshots.delete(key);
    }),
  };
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function resultOf(rows: unknown[][]) {
  return { columns: ["value"], rows, affected_rows: rows.length, execution_time_ms: 1 };
}

async function createAutoKeepTab() {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const tabId = store.createTab("mysql-1", "app", "Query");
  store.toggleResultAutoSave(tabId);
  const tab = () => store.tabs.find((item) => item.id === tabId)!;
  return { store, tabId, tab };
}

describe("useDataGridActions refreshActiveResultRun integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.tabResultSnapshots.clear();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options: { sql: string }) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
    mocks.executeMultiWithProgress.mockImplementation(async (connectionId: string, database: string, sql: string, onProgress: (progress: Record<string, unknown>) => void, schema: string | undefined, options: { executionId?: string } = {}) => {
      const results = await mocks.executeMulti(connectionId, database, sql, schema, options.executionId, options);
      const total = results.length;
      results.forEach((result: { statement_index?: number; execution_error?: boolean; execution_time_ms?: number; affected_rows?: number; error?: unknown }, index: number) => {
        const success = result.execution_error !== true;
        onProgress({
          executionId: options.executionId,
          statementIndex: result.statement_index ?? index,
          completed: index + 1,
          total,
          success,
          executionTimeMs: result.execution_time_ms,
          affectedRows: result.affected_rows,
          error: success ? undefined : result.error,
        });
      });
      return results;
    });
  });

  it("refreshes and auto-refreshes the active result run in place, while executions still add a run", async () => {
    mocks.executeMulti
      .mockResolvedValueOnce([resultOf([[1]])])
      .mockResolvedValueOnce([resultOf([[2]])])
      .mockResolvedValueOnce([resultOf([[3]])])
      .mockResolvedValueOnce([resultOf([[4]])])
      .mockResolvedValueOnce([resultOf([[5]])]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useDataGridActions } = await import("@/composables/useDataGridActions");
    const { tabId, tab } = await createAutoKeepTab();
    const store = useQueryStore();
    const actions = useDataGridActions(computed(() => tab()));

    // Two explicit executions: two result runs (auto-keep semantics).
    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");
    expect(tab().resultRuns).toHaveLength(2);
    const activeRunId = tab().activeResultRunId!;

    // Toolbar refresh goes through the same onReloadData path as DataGrid.
    await actions.onReloadData(tabId, "SELECT value FROM t", "", "", "", undefined, undefined, "refresh");
    expect(tab().resultRuns).toHaveLength(2);
    expect(tab().activeResultRunId).toBe(activeRunId);
    expect(tab().result?.rows).toEqual([[3]]);

    // Auto-refresh reuses the same in-place path.
    await actions.onReloadData(tabId, "SELECT value FROM t", "", "", "", undefined, undefined, "auto-refresh");
    expect(tab().resultRuns).toHaveLength(2);
    expect(tab().activeResultRunId).toBe(activeRunId);
    expect(tab().result?.rows).toEqual([[4]]);

    // Run / Cmd+Enter is still an execution and adds a result run.
    await actions.onExecuteSql(tabId, "SELECT value FROM t");
    expect(tab().resultRuns).toHaveLength(3);
    expect(tab().result?.rows).toEqual([[5]]);
  });
});
