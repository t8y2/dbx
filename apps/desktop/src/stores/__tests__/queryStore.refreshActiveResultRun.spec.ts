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
  tabResultSnapshots: new Map<string, unknown>(),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resultOf(rows: unknown[][]) {
  return { columns: ["value"], rows, affected_rows: rows.length, execution_time_ms: 1 };
}

async function createStore() {
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const tabId = store.createTab("mysql-1", "app", "Query");
  return { store, tabId };
}

describe("queryStore refreshActiveResultRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.tabResultSnapshots.clear();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    mocks.ensureConnected.mockResolvedValue(undefined);
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
        const statementIndex = result.statement_index ?? index;
        const success = result.execution_error !== true;
        onProgress({
          executionId: options.executionId,
          statementIndex,
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

  it("updates the active result run in place on refresh while auto-keep is enabled", async () => {
    mocks.executeMulti
      .mockResolvedValueOnce([resultOf([[1]])])
      .mockResolvedValueOnce([resultOf([[2]])])
      .mockResolvedValueOnce([resultOf([[3]])]);
    const { store, tabId } = await createStore();
    expect(store.toggleResultAutoSave(tabId)).toBe(true);

    // Two explicit executions keep two result runs (auto-keep semantics).
    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");
    let tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(2);
    const activeRunId = tab.activeResultRunId!;
    expect(activeRunId).toBeTruthy();
    expect(tab.result?.rows).toEqual([[2]]);

    // A refresh re-runs the displayed SQL but updates the active run instead of
    // appending another result tab (issue #13043).
    await store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });

    tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.activeResultRunId).toBe(activeRunId);
    expect(tab.result?.rows).toEqual([[3]]);
    expect(tab.resultRuns?.find((run) => run.id === activeRunId)?.result?.rows).toEqual([[3]]);
  });

  it("still captures a new run for explicit executions without the refresh flag", async () => {
    mocks.executeMulti
      .mockResolvedValueOnce([resultOf([[1]])])
      .mockResolvedValueOnce([resultOf([[2]])])
      .mockResolvedValueOnce([resultOf([[3]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);

    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");

    expect(store.tabs.find((item) => item.id === tabId)!.resultRuns).toHaveLength(3);
  });

  it("keeps the single displayed result on refresh when auto-keep is off", async () => {
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]).mockResolvedValueOnce([resultOf([[2]])]);
    const { store, tabId } = await createStore();

    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toBeUndefined();
    expect(tab.activeResultRunId).toBeUndefined();
    expect(tab.result?.rows).toEqual([[2]]);
  });

  it("refreshes a pinned active run in place without losing its pin", async () => {
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]).mockResolvedValueOnce([resultOf([[2]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "SELECT value FROM t");
    let tab = store.tabs.find((item) => item.id === tabId)!;
    const runId = tab.activeResultRunId!;
    expect(store.toggleResultRunPinned(tabId, runId)).toBe(true);

    await store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });

    tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.activeResultRunId).toBe(runId);
    expect(tab.resultRuns?.[0]?.pinned).toBe(true);
    expect(tab.result?.rows).toEqual([[2]]);
  });

  it("shows the in-place refresh on the active run instead of clearing the grid", async () => {
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]).mockResolvedValueOnce([resultOf([[2]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");
    const activeRunId = store.tabs.find((item) => item.id === tabId)!.activeResultRunId!;

    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const refresh = store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });

    await vi.waitFor(() => {
      const tab = store.tabs.find((item) => item.id === tabId)!;
      expect(tab.isExecuting).toBe(true);
      expect(tab.executingResultRunId).toBe(activeRunId);
      expect(tab.result?.rows).toEqual([[2]]);
    });

    pending.resolve([resultOf([[3]])]);
    await refresh;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    expect(tab.activeResultRunId).toBe(activeRunId);
    expect(tab.result?.rows).toEqual([[3]]);
    expect(tab.resultRuns).toHaveLength(2);
  });

  it("does not overwrite a run the user switched to while a refresh executes", async () => {
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]).mockResolvedValueOnce([resultOf([[2]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "SELECT value FROM t");
    await store.executeTabSql(tabId, "SELECT value FROM t");
    const tab0 = store.tabs.find((item) => item.id === tabId)!;
    const firstRunId = tab0.resultRuns![0]!.id;
    const secondRunId = tab0.activeResultRunId!;

    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const refresh = store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });
    await vi.waitFor(() => {
      expect(store.tabs.find((item) => item.id === tabId)!.executingResultRunId).toBe(secondRunId);
    });

    // The user switches to the first run while the refresh of the second run is
    // still in flight.
    await store.setActiveResultRun(tabId, firstRunId);
    pending.resolve([resultOf([[3]])]);
    await refresh;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    // Neither retained run may receive the refresh output of the other run.
    expect(tab.resultRuns?.find((run) => run.id === firstRunId)?.result?.rows).toEqual([[1]]);
    // The refreshed run kept its payload (possibly evicted to disk by the
    // switch); restoring it must show its own data, not the refresh output.
    await store.setActiveResultRun(tabId, secondRunId);
    expect(store.tabs.find((item) => item.id === tabId)!.result?.rows).toEqual([[2]]);
  });

  it("keeps the retained run dataset when an in-place refresh fails", async () => {
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "SELECT value FROM t");
    const runId = store.tabs.find((item) => item.id === tabId)!.activeResultRunId!;

    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const refresh = store.executeTabSql(tabId, "SELECT value FROM t", {
      resultBaseSql: "SELECT value FROM t",
      preserveResultDuringExecution: true,
      refreshActiveResultRun: true,
    });
    await vi.waitFor(() => {
      expect(store.tabs.find((item) => item.id === tabId)!.isExecuting).toBe(true);
    });
    pending.reject(new Error("connection lost"));
    await refresh;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    expect(tab.activeResultRunId).toBe(runId);
    // The error stays on the displayed surface; the retained run keeps its data.
    expect(tab.result?.execution_error).toBe(true);
    expect(tab.resultRuns?.find((run) => run.id === runId)?.result?.rows).toEqual([[1]]);
    expect(tab.resultRuns?.find((run) => run.id === runId)?.result?.execution_error).toBeFalsy();
  });
});
