import { nextTick, watch } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inlineQueryResultEntries } from "@/lib/editor/inlineQueryResultEntries";
const mocks = vi.hoisted(() => ({
  writeSnapshot: vi.fn(),
  executeMulti: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  analyze: vi.fn(),
  closeQuerySession: vi.fn(),
  settings: { inlineQueryResults: true, pageSize: 100, globalQueryTimeoutSecs: 30, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false },
}));
vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tabs/tabResultCache")>()),
  writeTabResultSnapshot: mocks.writeSnapshot,
  deleteTabResultSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  closeQuerySession: mocks.closeQuerySession,
  closeClientConnectionSession: vi.fn().mockResolvedValue(true),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  prepareQueryPaginationExecutionPlan: vi.fn(async ({ sql }: { sql: string }) => ({ sqlToExecute: sql })),
  analyzeEditableQueryEditability: mocks.analyze,
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "mysql-1", name: "MySQL", db_type: "mysql", query_timeout_secs: 30 }),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    recordConnectionLostError: vi.fn(),
    connectionIdentifierQuote: () => "`",
  }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: mocks.settings }) }));
describe("queryStore inline executions", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeSnapshot.mockResolvedValue(true);
    mocks.analyze.mockResolvedValue({ editable: false, reason: "no-table" });
    mocks.settings.inlineQueryResults = true;
    setActivePinia(createPinia());
    mocks.executeMulti.mockImplementation(async (_id, _database, sql: string) => [{ columns: ["value"], rows: [[sql.includes("2") ? 2 : 1]], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.closeQuerySession.mockResolvedValue(true);
  });
  it.each(["autosaved", "pinned", "auto-save-disabled"])("keeps %s rows after successful history persistence and a different statement executes", async (mode) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs[0]!;
    tab.sql = "SELECT 1;\nSELECT 2;";
    store.toggleResultAutoSave(id);
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    const first = tab.result!;
    if (mode === "pinned") store.toggleResultRunPinned(id, tab.activeResultRunId!);
    if (mode === "auto-save-disabled") store.toggleResultAutoSave(id);
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    await vi.waitFor(() => expect(mocks.writeSnapshot).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.rows).toEqual([[1]]);
    expect(inlineQueryResultEntries(tab).map((entry) => entry.result.rows[0]?.[0])).toEqual([1, 2]);
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: [[11]], affected_rows: 0, execution_time_ms: 1 }]);
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inlineQueryResultEntries(tab).map((entry) => entry.result.rows[0]?.[0])).toEqual([11, 2]);
    release();
  });
  it("rechecks inline retention when an earlier disk write finishes after opting in", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs[0]!;
    tab.sql = "SELECT 1;\nSELECT 2;";
    store.toggleResultAutoSave(id);
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    const first = tab.result!;
    mocks.settings.inlineQueryResults = false;
    const finishWrites: Array<(value: boolean) => void> = [];
    mocks.writeSnapshot.mockImplementation(() => new Promise((resolve) => finishWrites.push(resolve)));
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    await vi.waitFor(() => expect(finishWrites.length).toBeGreaterThan(0));
    mocks.settings.inlineQueryResults = true;
    finishWrites.forEach((finish) => finish(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.rows).toEqual([[1]]);
    expect(inlineQueryResultEntries(tab)).toHaveLength(2);
    mocks.writeSnapshot.mockResolvedValue(true);
    release();
  });
  it("applies the same memory budget to pinned and autosaved history without deleting history", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs[0]!;
    store.toggleResultAutoSave(id);
    for (let i = 0; i < 10; i++) {
      await store.executeTabSql(id, `SELECT ${i};`, { sourceOffset: i * 10 });
      if (i === 0) store.toggleResultRunPinned(id, tab.activeResultRunId!);
    }
    await vi.waitFor(() => expect(tab.resultRuns![0]!.resultEvicted).toBe(true));
    expect(tab.resultRuns).toHaveLength(10);
    expect(tab.resultRuns![0]!.pinned).toBe(true);
    expect(tab.resultRuns!.filter((run) => run.result)).toHaveLength(9);
    expect(tab.resultRuns![0]!.resultCacheState).toBe("disk");
    release();
  });
  it("retains two separately executed statements and replaces only the rerun slot", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs.find((tab) => tab.id === id)!;
    tab.sql = "SELECT 1;\nSELECT 2;";
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    expect(mocks.executeMulti).toHaveBeenCalledTimes(2);
    expect(inlineQueryResultEntries(tab).map(({ result }) => result.rows[0]?.[0])).toEqual([1, 2]);
    expect(tab.resultAutoSave).not.toBe(true);
    expect(tab.resultRuns?.every((run) => run.inlineRetained)).toBe(true);
    // A post-flush UI watcher may briefly see only the incoming statement
    // before its execution record is captured. Never prune during that phase.
    tab.isExecuting = true;
    store.pruneInlineResultRuns(id, new Set());
    expect(tab.resultRuns).toHaveLength(2);
    tab.isExecuting = false;
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    const entries = inlineQueryResultEntries(tab);
    expect(entries).toHaveLength(2);
    store.pruneInlineResultRuns(id, new Set(entries.map((entry) => entry.run!.id)));
    expect(tab.resultRuns).toHaveLength(2);
    release();
  });
  it("keeps the other batch result while a single statement is published and finalized", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs[0]!;
    tab.sql = "SELECT 1;\nSELECT 2;";
    const payload = (value: number) => ({ columns: ["value"], rows: [[value]], affected_rows: 0, execution_time_ms: 1 });

    mocks.executeMultiWithProgress.mockResolvedValueOnce([payload(1), payload(2)]);
    const stop = watch(
      () => inlineQueryResultEntries(tab),
      (entries) => store.pruneInlineResultRuns(id, new Set(entries.flatMap((entry) => (entry.run ? [entry.run.id] : [])))),
      { flush: "post" },
    );
    try {
      await store.executeCurrentSql(tab.sql, { tabId: id, sourceOffset: 0 });
      await nextTick();
      const untouched = inlineQueryResultEntries(tab)[1]!.result;
      let finishMetadata!: (value: { editable: boolean; reason: string }) => void;
      mocks.analyze.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMetadata = resolve;
          }),
      );
      mocks.executeMulti.mockResolvedValueOnce([payload(11)]);
      const execution = store.executeCurrentSql("SELECT 1;", { tabId: id, sourceOffset: 0 });
      await vi.waitFor(() => expect(finishMetadata).toBeDefined());
      await nextTick();
      expect(inlineQueryResultEntries(tab)[1]!.result).toBe(untouched);
      finishMetadata({ editable: false, reason: "no-table" });
      await execution;
      await nextTick();
      expect(inlineQueryResultEntries(tab).map((entry) => entry.result.rows[0]?.[0])).toEqual([11, 2]);
      expect(inlineQueryResultEntries(tab)[1]!.result).toBe(untouched);
      mocks.executeMulti.mockResolvedValueOnce([payload(22)]);
      await store.executeCurrentSql("SELECT 2;", { tabId: id, sourceOffset: 10 });
      await nextTick();
      expect(inlineQueryResultEntries(tab).map((entry) => entry.result.rows[0]?.[0])).toEqual([11, 22]);
    } finally {
      stop();
      release();
    }
  });
  it("does not retain results when the inline setting is disabled", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    mocks.settings.inlineQueryResults = false;
    const id = store.createTab("mysql-1", "db", "Query", "query");
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    expect(store.tabs[0]!.resultRuns?.length ?? 0).toBe(0);
    release();
  });
  it("bounds inactive runs and keeps a recently activated older result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs[0]!;
    tab.sql = Array.from({ length: 12 }, (_, i) => `SELECT ${i};`).join("\n");
    for (let i = 0; i < 9; i++) await store.executeTabSql(id, `SELECT ${i};`, { sourceOffset: tab.sql.indexOf(`SELECT ${i};`) });
    const oldest = tab.resultRuns![0]!;
    await store.setActiveResultRun(id, oldest.id);
    await store.executeTabSql(id, "SELECT 9;", { sourceOffset: tab.sql.indexOf("SELECT 9;") });
    expect(tab.resultRuns).toHaveLength(9);
    expect(tab.resultRuns!.some((run) => run.id === oldest.id)).toBe(true);
    expect(tab.resultRuns!.some((run) => run.sequence === 2)).toBe(false);
    release();
  });
  it("evicts an inactive oversized result while retaining the current result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["value"], rows: Array.from({ length: 20001 }, () => [1]), affected_rows: 0, execution_time_ms: 1 }]);
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    expect(store.tabs[0]!.resultRuns).toHaveLength(1);
    expect(store.tabs[0]!.result?.rows[0]).toEqual([2]);
    release();
  });
  it("restores per-result state through the action without changing tab ownership", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { captureInlineResultState } = await import("@/lib/editor/inlineQueryResultState");
    const store = useQueryStore();
    const release = store.retainInlineQueryResults();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    const tab = store.tabs[0]!;
    const first = tab.resultRuns![0]!;
    tab.resultSortColumn = "first";
    tab.resultPageOffset = 100;
    const snapshot = captureInlineResultState(tab);
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    expect(store.activateInlineQueryResult(id, first.result!, 0, first.id, { ...snapshot, id: "wrong", sql: "wrong", txnSessionId: "wrong" })).toBe(true);
    expect(tab.id).toBe(id);
    expect(tab.sql).not.toBe("wrong");
    expect(tab.txnSessionId).not.toBe("wrong");
    expect(tab.resultSortColumn).toBe("first");
    expect(tab.resultPageOffset).toBe(100);
    expect(store.activateInlineQueryResult(id, tab.result!, 0, "missing", snapshot)).toBe(false);
    release();
  });
  it("keeps the original replacement behavior when no inline editor is mounted", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "db", "Query", "query");
    const tab = store.tabs.find((tab) => tab.id === id)!;
    tab.sql = "SELECT 1;\nSELECT 2;";
    await store.executeTabSql(id, "SELECT 1;", { sourceOffset: 0 });
    await store.executeTabSql(id, "SELECT 2;", { sourceOffset: 10 });
    expect(tab.resultRuns?.length ?? 0).toBe(0);
    expect(tab.result?.rows[0]?.[0]).toBe(2);
  });
});
