import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ executeMulti: vi.fn(), subscribe: vi.fn(), cleanup: vi.fn(), getConfig: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMulti,
  subscribeQueryMessages: mocks.subscribe,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false })),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConfig,
    lookupLocalCompletionTables: () => [],
    recordConnectionLostError: vi.fn(),
  }),
}));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { pageSize: 100, autoCalculateTotalRows: false } }) }));

const emptyResults: QueryResult[] = [{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [] }];

describe("queryStore SQL*Plus rerun (`/`)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    setActivePinia(createPinia());
    mocks.subscribe.mockResolvedValue(mocks.cleanup);
    mocks.executeMulti.mockImplementation(async () => emptyResults.map((result) => ({ ...result })));
  });

  it("a script that is only `/` re-executes the tab's last statement", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    mocks.executeMulti.mockClear();

    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  }, 30_000);

  it("DM8 query-window slash reruns only the last successful statement", async () => {
    mocks.getConfig.mockReturnValue({ id: "dm-1", name: "DM8", db_type: "dameng", database: "", query_timeout_secs: 30 });
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("dm-1", "", "Query");
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResults[0], statement_index: 0 },
      { ...emptyResults[0], statement_index: 1 },
    ]);
    await store.executeTabSql(tabId, "UPDATE t SET v=1 WHERE id=1;\nSELECT 1 FROM DUAL;");
    mocks.executeMulti.mockClear();
    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  });

  it("a `/` without execution history is sent unchanged", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");

    store.tabs.find((tab) => tab.id === tabId)!.lastExecutedSql = "INSERT INTO t VALUES (1); SELECT 1 FROM DUAL;";
    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("/");
  }, 30_000);

  it("reruns only the last successful statement of a batch", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    const sql = "INSERT INTO t VALUES (1);\nSELECT 1 FROM DUAL;";
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResults[0], statement_index: 0 },
      { ...emptyResults[0], statement_index: 1 },
    ]);
    await store.executeTabSql(tabId, sql);
    expect(store.tabs.find((tab) => tab.id === tabId)?.lastExecutedSql).toBe(sql);
    mocks.executeMulti.mockClear();

    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  });

  it("does not rerun statements skipped after EXIT or a failed statement", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResults[0], statement_index: 0 },
      { ...emptyResults[0], statement_index: 1, execution_error: true },
      { ...emptyResults[0], statement_index: 2 },
    ]);
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL;\nSELECT missing FROM DUAL;\nEXIT\nINSERT INTO t VALUES (1);");
    mocks.executeMulti.mockClear();

    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  });

  it("preserves the previous successful statement after a failed request", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");
    mocks.executeMulti.mockRejectedValueOnce(new Error("query failed"));
    await store.executeTabSql(tabId, "SELECT missing FROM DUAL");
    mocks.executeMulti.mockClear();

    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  });

  it("keeps an anonymous block whole when rerunning it", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    const block = "BEGIN\n  NULL;\nEND;";
    await store.executeTabSql(tabId, `${block}\n/`);
    mocks.executeMulti.mockClear();

    await store.executeTabSql(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe(block);
  });

  it.each(["database", "schema", "connection"])("clears console history after changing %s", async (target) => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");
    if (target === "database") store.updateDatabase(tabId, "other");
    if (target === "schema") store.updateSchema(tabId, "OTHER");
    if (target === "connection") store.updateConnection(tabId, "oracle-2", "ORCL");
    expect(store.tabs.find((tab) => tab.id === tabId)?.lastConsoleSql).toBeUndefined();
  });

  it("clears console history when a detached tab is rebound to another connection", async () => {
    const { useQueryStore } = await import("../queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Query");
    await store.executeTabSql(tabId, "SELECT 1 FROM DUAL");
    const tab = store.tabs.find((tab) => tab.id === tabId)!;
    tab.detachedConnectionName = "Oracle";
    expect(store.rebindDetachedTabs("Oracle", "oracle-2")).toBe(1);
    expect(tab.lastConsoleSql).toBeUndefined();
  });
});
