import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inlineQueryResultEntries } from "@/lib/editor/inlineQueryResultEntries";
const mocks = vi.hoisted(() => ({ executeMulti: vi.fn(), closeQuerySession: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  closeQuerySession: mocks.closeQuerySession,
  closeClientConnectionSession: vi.fn().mockResolvedValue(true),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  prepareQueryPaginationExecutionPlan: vi.fn(async ({ sql }: { sql: string }) => ({ sqlToExecute: sql })),
  analyzeEditableQueryEditability: vi.fn().mockResolvedValue({ editable: false, reason: "no-table" }),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "mysql-1", name: "MySQL", db_type: "mysql", query_timeout_secs: 30 }),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    recordConnectionLostError: vi.fn(),
    connectionIdentifierQuote: () => "`",
  }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { pageSize: 100, globalQueryTimeoutSecs: 30, openTabsRestoreMode: "all", confirmUnsavedSqlClose: false } }) }));
describe("queryStore inline executions", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mocks.executeMulti.mockImplementation(async (_id, _database, sql: string) => [{ columns: ["value"], rows: [[sql.includes("2") ? 2 : 1]], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.closeQuerySession.mockResolvedValue(true);
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
