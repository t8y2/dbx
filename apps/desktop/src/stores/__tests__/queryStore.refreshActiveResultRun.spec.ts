import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";
import { hasQueryExecutionLog, isDisplayingHistoricalQueryResult, queryExecutionLog } from "@/lib/query/queryExecutionLog";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
  executeInManualTransaction: vi.fn(),
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
  executeInManualTransaction: mocks.executeInManualTransaction,
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

  it.each(["mysql", "sqlserver", "manual"] as const)("keeps %s live output distinct from explicit history and clears selection ownership after completion and cancellation", async (mode) => {
    if (mode === "sqlserver") mocks.getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "SQL Server", db_type: "sqlserver", database: "app", query_timeout_secs: 30 });
    const execute = mode === "manual" ? mocks.executeInManualTransaction : mocks.executeMulti;
    const response = () => [0, 1].map((statement_index) => ({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index }));
    execute.mockResolvedValueOnce(response());
    const { store, tabId } = await createStore();
    const tab = store.tabs.find((item) => item.id === tabId)!;
    if (mode === "manual") {
      tab.autoCommit = false;
      tab.txnSessionId = "existing-manual-session";
    }
    store.toggleResultAutoSave(tabId);
    const oldSql = "UPDATE archived SET value = 1; UPDATE archived SET value = 2";
    const currentSql = "UPDATE current_table SET value = 3; UPDATE current_table SET value = 4";
    await store.executeTabSql(tabId, oldSql);
    const oldRunId = tab.activeResultRunId!;
    expect(oldRunId).toBeTruthy();
    const pending = deferred<ReturnType<typeof response>>();
    execute.mockImplementationOnce(() => pending.promise);
    const run = store.executeTabSql(tabId, currentSql);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    // Auto-keep leaves the old dataset mounted without selecting its history.
    expect(tab.activeResultRunId).toBe(oldRunId);
    expect(tab.executingResultRunId).toBeNull();
    expect(tab.resultRunSelectionExecutionId).toBeUndefined();
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(false);
    if (mode === "mysql") {
      expect(tab.batchSqlExecution?.executionId).toBe(tab.executionId);
      expect(queryExecutionLog(tab, (key) => key)?.message).toContain("UPDATE current_table");
    } else {
      expect(tab.batchSqlExecution).toBeUndefined();
      expect(hasQueryExecutionLog(tab)).toBe(false);
      expect(queryExecutionLog(tab, (key) => key)).toBeUndefined();
    }

    // An explicit switch during the pending request owns its historical output.
    expect(await store.setActiveResultRun(tabId, oldRunId, { evictInactive: false })).toBe(true);
    expect(tab.resultRunSelectionExecutionId).toBe(tab.executionId);
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(true);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("UPDATE archived");
    expect(queryExecutionLog(tab, (key) => key)?.message).not.toContain("UPDATE current_table");
    pending.resolve(response());
    await run;
    expect(tab.isExecuting).toBe(false);
    expect(tab.resultRunSelectionExecutionId).toBeUndefined();
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("UPDATE current_table");

    // A new execution must not inherit the prior history selection, including
    // when the backend reports that its cancellation already completed.
    const cancelled = deferred<ReturnType<typeof response>>();
    execute.mockImplementationOnce(() => cancelled.promise);
    const nextRun = store.executeTabSql(tabId, currentSql);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(false);
    await store.setActiveResultRun(tabId, oldRunId, { evictInactive: false });
    expect(isDisplayingHistoricalQueryResult(tab)).toBe(true);
    mocks.cancelQuery.mockResolvedValueOnce(false);
    await store.cancelTabExecution(tabId);
    expect(tab.isExecuting).toBe(false);
    expect(tab.resultRunSelectionExecutionId).toBeUndefined();
    cancelled.resolve(response());
    await nextRun;
    expect(tab.resultRunSelectionExecutionId).toBeUndefined();
  });

  it.each(["connection", "execution"] as const)("preserves the retained batch when a child result is selected during %s", async (stage) => {
    const oldSql = "SELECT 1 AS old_a; SELECT 2 AS old_b";
    const newSql = "SELECT 3 AS fresh_value";
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]]), resultOf([[2]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, oldSql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const oldRunId = tab.activeResultRunId!;
    const archivedBatch = JSON.stringify(tab.batchSqlExecution);
    const connecting = deferred<void>();
    const pending = deferred<ReturnType<typeof resultOf>[]>();
    if (stage === "connection") mocks.ensureConnected.mockImplementationOnce(() => connecting.promise);
    else mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const execution = store.executeTabSql(tabId, newSql);
    await vi.waitFor(() => expect(stage === "connection" ? mocks.ensureConnected : mocks.executeMulti).toHaveBeenCalledTimes(2));

    store.setActiveResultIndex(tabId, 1);
    expect(tab.resultRuns![0]!.activeResultIndex).toBe(1);
    expect(JSON.stringify(tab.resultRuns![0]!.batchSqlExecution)).toBe(archivedBatch);
    const cancelling = store.cancelTabExecution(tabId);
    if (stage === "connection") connecting.resolve();
    else pending.reject(new Error("Query canceled"));
    await cancelling;
    await execution;
    expect(tab.activeResultRunId).toBe(oldRunId);
    expect(tab.result?.sourceStatement).toContain("old_b");
    expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("old_a");
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("old_b");
    expect(queryExecutionLog(tab, (key) => key)?.message).not.toContain("fresh_value");
    await store.setActiveResultRun(tabId, oldRunId);
    expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
  });

  it.each([false, true])("preserves the retained batch across local-sort result copies while another execution is cancelled (disk restored=%s)", async (fromCache) => {
    const oldSql = "SELECT 2 AS value UNION ALL SELECT 1 AS value";
    const nextSql = "SELECT 3 AS fresh_value";
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[2], [1]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, oldSql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const oldRunId = tab.activeResultRunId!;
    if (fromCache) {
      mocks.executeMulti.mockResolvedValueOnce([resultOf([[9]])]);
      await store.executeTabSql(tabId, "SELECT 9 AS another_value");
      await vi.waitFor(() => expect(tab.resultRuns!.find((run) => run.id === oldRunId)!.result).toBeUndefined());
      await store.setActiveResultRun(tabId, oldRunId);
      // The persisted result codec intentionally omits the execution ID.
      expect(tab.result?.sourceExecutionId).toBeUndefined();
    }
    const archivedBatch = JSON.stringify(tab.batchSqlExecution);
    const sourceExecutionId = tab.result?.sourceExecutionId;
    if (!fromCache) expect(sourceExecutionId).toBeTruthy();
    expect(tab.results).toBeUndefined();
    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const executionCount = mocks.executeMulti.mock.calls.length;
    const execution = store.executeTabSql(tabId, nextSql);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(executionCount + 1));
    for (const direction of ["asc", "desc", null] as const) {
      const previousResult = tab.result;
      store.sortTabResultLocally(tabId, "value", 0, direction);
      expect(tab.result).not.toBe(previousResult);
      expect(tab.result?.sourceExecutionId).toBe(sourceExecutionId);
      expect(tab.result?.rows).toEqual(direction === "asc" ? [[1], [2]] : [[2], [1]]);
      expect(JSON.stringify(tab.resultRuns![0]!.batchSqlExecution)).toBe(archivedBatch);
    }
    const cancelling = store.cancelTabExecution(tabId);
    pending.reject(new Error("Query canceled"));
    await cancelling;
    await execution;
    expect(tab.activeResultRunId).toBe(oldRunId);
    expect(tab.result?.sourceStatement).toBe(oldSql);
    expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain(oldSql);
    expect(queryExecutionLog(tab, (key) => key)?.message).not.toContain(nextSql);
    await store.setActiveResultRun(tabId, oldRunId);
    expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
  });

  it("preserves the retained batch when its delayed metadata finishes during another execution", async () => {
    const metadata = deferred<{ editable: false; reason: "aggregation" }>();
    mocks.analyzeEditableQueryEditability.mockImplementationOnce(() => metadata.promise);
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "SELECT 1 AS retained_value");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(mocks.analyzeEditableQueryEditability).toHaveBeenCalledTimes(1));
    const archivedBatch = JSON.stringify(tab.batchSqlExecution);
    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const execution = store.executeTabSql(tabId, "SELECT 2 AS fresh_value");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    metadata.resolve({ editable: false, reason: "aggregation" });
    await vi.waitFor(() => expect(tab.queryEditabilityReason).toBe("aggregation"));
    expect(JSON.stringify(tab.resultRuns![0]!.batchSqlExecution)).toBe(archivedBatch);
    const cancelling = store.cancelTabExecution(tabId);
    pending.reject(new Error("Query canceled"));
    await cancelling;
    await execution;
    expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("retained_value");
    expect(queryExecutionLog(tab, (key) => key)?.message).not.toContain("fresh_value");
  });

  it("keeps the old snapshot during child selection in a refresh and publishes the completed refresh batch", async () => {
    const sql = "SELECT 1 AS first_value; SELECT 2 AS second_value";
    mocks.executeMulti.mockResolvedValueOnce([resultOf([[1]]), resultOf([[2]])]);
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, sql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const oldRunId = tab.activeResultRunId!;
    const archivedBatch = JSON.stringify(tab.batchSqlExecution);
    const pending = deferred<ReturnType<typeof resultOf>[]>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const refresh = store.executeTabSql(tabId, sql, { refreshActiveResultRun: true });
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    const executionId = tab.executionId;
    store.setActiveResultIndex(tabId, 1);
    expect(tab.batchSqlExecution?.executionId).toBe(executionId);
    expect(JSON.stringify(tab.resultRuns![0]!.batchSqlExecution)).toBe(archivedBatch);
    pending.resolve([resultOf([[3]]), { ...resultOf([[4]]), execution_time_ms: 37 }]);
    await refresh;
    expect(tab.activeResultRunId).toBe(oldRunId);
    expect(tab.resultRuns).toHaveLength(1);
    expect(tab.resultRuns![0]!.batchSqlExecution?.executionId).toBe(executionId);
    expect(tab.resultRuns![0]!.batchSqlExecution?.items[1]).toMatchObject({ status: "success", executionTimeMs: 37 });
    expect(tab.resultRuns![0]!.batchSqlExecution?.finishedAt).toBeDefined();
    await store.setActiveResultRun(tabId, oldRunId);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("37 ms");
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

    await store.setActiveResultRun(tabId, activeRunId, { evictInactive: false });
    const refreshingTab = store.tabs.find((item) => item.id === tabId)!;
    expect(refreshingTab.resultRunSelectionExecutionId).toBe(refreshingTab.executionId);
    expect(isDisplayingHistoricalQueryResult(refreshingTab)).toBe(false);
    pending.resolve([resultOf([[3]])]);
    await refresh;

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    expect(tab.resultRunSelectionExecutionId).toBeUndefined();
    expect(tab.activeResultRunId).toBe(activeRunId);
    expect(tab.result?.rows).toEqual([[3]]);
    expect(tab.resultRuns).toHaveLength(2);
  });

  it.each([false, true])("restores live refresh progress after switching away and back (during connection preparation=%s)", async (duringPreparation) => {
    const archivedSql = "UPDATE archived SET value = 1";
    const currentSql = "UPDATE current_table SET value = 2; UPDATE current_table SET value = 3";
    const response = () => [0, 1].map((statement_index) => ({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index }));
    mocks.executeMulti.mockResolvedValueOnce([response()[0]]).mockResolvedValueOnce(response());
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, archivedSql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const archivedRunId = tab.activeResultRunId!;
    await store.executeTabSql(tabId, currentSql);
    const refreshingRunId = tab.activeResultRunId!;
    const archivedBatch = JSON.stringify(tab.resultRuns!.find((run) => run.id === archivedRunId)!.batchSqlExecution);
    const pending = deferred<ReturnType<typeof response>>();
    mocks.executeMulti.mockImplementationOnce(() => pending.promise);
    const connecting = deferred<void>();
    if (duringPreparation) mocks.ensureConnected.mockImplementationOnce(() => connecting.promise);
    const refresh = store.executeTabSql(tabId, currentSql, { preserveResultDuringExecution: true, refreshActiveResultRun: true });

    await vi.waitFor(() => expect(duringPreparation ? mocks.ensureConnected : mocks.executeMulti).toHaveBeenCalledTimes(3));
    await store.setActiveResultRun(tabId, archivedRunId);
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain(archivedSql);
    if (duringPreparation) {
      // Returning before a batch exists must not resurrect the old success log.
      await store.setActiveResultRun(tabId, refreshingRunId);
      expect(tab.batchSqlExecution).toBeUndefined();
      expect(hasQueryExecutionLog(tab)).toBe(false);
      await store.setActiveResultRun(tabId, archivedRunId);
      connecting.resolve();
      await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(3));
      expect(queryExecutionLog(tab, (key) => key)?.message).toContain(archivedSql);
      expect(isDisplayingHistoricalQueryResult(tab)).toBe(true);
    }

    // The new multi-statement execution still subscribes to progress when the
    // displayed historical run contains just one statement.
    expect(mocks.executeMultiWithProgress).toHaveBeenCalledTimes(2);
    const onProgress = mocks.executeMultiWithProgress.mock.calls[1]![3];
    const executionId = tab.executionId;
    onProgress({ executionId, statementIndex: 0, completed: 1, total: 2, success: true, affectedRows: 7, executionTimeMs: 23 });
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain(archivedSql);
    await store.setActiveResultRun(tabId, refreshingRunId);
    expect(tab.batchSqlExecution?.executionId).toBe(executionId);
    expect(tab.batchSqlExecution?.items[0]).toMatchObject({ status: "success", affectedRows: 7, executionTimeMs: 23 });
    const log = computed(() => queryExecutionLog(tab, (key) => key)?.message);
    expect(log.value).toContain("statuses.running");
    expect(log.value).not.toContain(archivedSql);
    onProgress({ executionId, statementIndex: 1, completed: 2, total: 2, success: true, affectedRows: 9, executionTimeMs: 47 });
    // Cached computed output must be invalidated by live progress after return.
    expect(log.value).not.toContain("statuses.running");
    expect(log.value).toContain("47 ms");
    expect(JSON.stringify(tab.resultRuns!.find((run) => run.id === archivedRunId)!.batchSqlExecution)).toBe(archivedBatch);
    pending.resolve(response());
    await refresh;
    expect(tab.activeResultRunId).toBe(refreshingRunId);
    expect(tab.resultRuns).toHaveLength(2);
  });

  it.each((["connection", "pagination"] as const).flatMap((stage) => (["new-result", "auto-keep"] as const).flatMap((mode) => [false, true].map((acknowledged) => ({ stage, mode, acknowledged })))))(
    "preserves retained output when cancelled during $stage preparation ($mode, acknowledged=$acknowledged)",
    async ({ stage, mode, acknowledged }) => {
      const oldSql = "UPDATE archived SET value = 1; UPDATE archived SET value = 2";
      const nextSql = "UPDATE current_table SET value = 3; UPDATE current_table SET value = 4";
      const oldMessages = [{ severity: "NOTICE", message: "retained notice" }];
      mocks.executeMulti.mockResolvedValueOnce([0, 1].map((statement_index) => ({ columns: [], rows: [], affected_rows: 7, execution_time_ms: 23, statement_index, messages: oldMessages })));
      const { store, tabId } = await createStore();
      if (mode === "auto-keep") store.toggleResultAutoSave(tabId);
      await store.executeTabSql(tabId, oldSql);
      const tab = store.tabs.find((item) => item.id === tabId)!;
      const archivedBatch = JSON.stringify(tab.batchSqlExecution);
      const oldLog = queryExecutionLog(tab, (key) => key)?.message;
      const preparation = deferred<void>();
      if (stage === "connection") mocks.ensureConnected.mockImplementationOnce(() => preparation.promise);
      else
        mocks.prepareQueryPaginationExecutionPlan.mockImplementationOnce(async (options: { sql: string }) => {
          await preparation.promise;
          return { sqlToExecute: options.sql, useAgentResultSession: false };
        });
      const preparationMock = stage === "connection" ? mocks.ensureConnected : mocks.prepareQueryPaginationExecutionPlan;
      const preparationCount = preparationMock.mock.calls.length;
      const execution = store.executeTabSql(tabId, nextSql, { openInNewResultTab: mode === "new-result" });
      await vi.waitFor(() => expect(preparationMock).toHaveBeenCalledTimes(preparationCount + 1));
      tab.liveQueryMessages = [{ severity: "NOTICE", message: "cancelled notice" }];
      mocks.cancelQuery.mockResolvedValueOnce(acknowledged);
      await store.cancelTabExecution(tabId);
      preparation.resolve();
      await execution;

      expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
      expect(tab.isExecuting).toBe(false);
      expect(tab.resultRuns).toHaveLength(1);
      expect(tab.result?.messages).toEqual(oldMessages);
      expect(tab.liveQueryMessages).toBeUndefined();
      expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
      expect(JSON.stringify(tab.resultRuns![0]!.batchSqlExecution)).toBe(archivedBatch);
      expect(queryExecutionLog(tab, (key) => key)?.message).toBe(oldLog);
      await store.setActiveResultRun(tabId, tab.activeResultRunId!);
      expect(JSON.stringify(tab.batchSqlExecution)).toBe(archivedBatch);
    },
  );

  it.each(["connection", "pagination"] as const)("keeps cancelled output without a retained run during %s preparation", async (stage) => {
    const { store, tabId } = await createStore();
    const preparation = deferred<void>();
    if (stage === "connection") mocks.ensureConnected.mockImplementationOnce(() => preparation.promise);
    else
      mocks.prepareQueryPaginationExecutionPlan.mockImplementationOnce(async (options: { sql: string }) => {
        await preparation.promise;
        return { sqlToExecute: options.sql, useAgentResultSession: false };
      });
    const execution = store.executeTabSql(tabId, "UPDATE current_table SET value = 1; UPDATE current_table SET value = 2");
    await vi.waitFor(() => expect(stage === "connection" ? mocks.ensureConnected : mocks.prepareQueryPaginationExecutionPlan).toHaveBeenCalled());
    await store.cancelTabExecution(tabId);
    preparation.resolve();
    await execution;
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.isExecuting).toBe(false);
    expect(tab.batchSqlExecution?.items[0]?.status).toBe("cancelled");
    expect(tab.batchSqlExecution?.items[1]?.status).toBe("skipped");
    expect(queryExecutionLog(tab, (key) => key)?.message).toContain("statuses.cancelled");
  });

  it("does not restore a stale batch when switching back to a nonbatch manual refresh", async () => {
    const sql = "UPDATE t SET value = 1; UPDATE t SET value = 2";
    const response = () => [0, 1].map((statement_index) => ({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index }));
    mocks.executeMulti.mockResolvedValueOnce(response()).mockResolvedValueOnce(response());
    const { store, tabId } = await createStore();
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, sql);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const oldRunId = tab.activeResultRunId!;
    await store.executeTabSql(tabId, sql);
    const refreshingRunId = tab.activeResultRunId!;
    expect(tab.batchSqlExecution).toBeDefined();
    tab.autoCommit = false;
    tab.txnSessionId = "existing-manual-session";
    const pending = deferred<ReturnType<typeof response>>();
    mocks.executeInManualTransaction.mockImplementationOnce(() => pending.promise);
    const refresh = store.executeTabSql(tabId, sql, { preserveResultDuringExecution: true, refreshActiveResultRun: true });
    await vi.waitFor(() => expect(mocks.executeInManualTransaction).toHaveBeenCalled());
    await store.setActiveResultRun(tabId, oldRunId);
    expect(hasQueryExecutionLog(tab)).toBe(true);
    await store.setActiveResultRun(tabId, refreshingRunId);
    expect(tab.batchSqlExecution).toBeUndefined();
    expect(hasQueryExecutionLog(tab)).toBe(false);
    pending.resolve(response());
    await refresh;
    expect(hasQueryExecutionLog(tab)).toBe(true);
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
