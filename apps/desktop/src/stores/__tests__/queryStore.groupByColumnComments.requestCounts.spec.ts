import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Request-count regression for grouped-query display metadata enrichment.
 *
 * Proves the contract from the #6463 review:
 * - GROUP BY result-comment enrichment issues `getColumns` only (never
 *   `listIndexes` for display);
 * - cold-cache counts are linear in the number of distinct source tables;
 * - warm repeat issues zero additional metadata calls;
 * - concurrent same-table enrichments dedupe to a single `getColumns`;
 * - multi-source loads are scheduled under bounded concurrency;
 * - metadata failure never affects the query result or editability.
 */

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const getConnectionConfig = vi.fn();
const lookupLocalCompletionTables = vi.fn();
const buildSortedQuerySql = vi.fn();
const buildDataGridCountSql = vi.fn();
const prepareQueryPaginationExecutionPlan = vi.fn(async (options) => ({
  sqlToExecute: options.sql,
  pageSql: undefined,
  pageLimit: undefined,
  pageOffset: undefined,
  countSql: undefined,
  useAgentResultSession: false,
}));
const editorSettings = {
  pageSize: 100,
  autoCalculateTotalRows: false,
};

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability,
  buildDataGridCountSql,
  buildSortedQuerySql,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  executeMulti,
  executeQuery,
  getColumns,
  listIndexes,
  listObjects,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings,
  }),
}));

function column(name: string, comment: string | null, isPrimaryKey = false) {
  return { name, data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: isPrimaryKey, extra: null, comment };
}

const usersColumns = [column("id", "用户ID", true), column("department", "所属部门")];
const ordersColumns = [column("id", "订单ID", true), column("user_id", "下单用户")];
const paymentsColumns = [column("id", "支付ID", true), column("user_id", "支付用户")];

function columnSetFor(table: string) {
  if (table === "orders") return ordersColumns;
  if (table === "payments") return paymentsColumns;
  return usersColumns;
}

describe("queryStore grouped-result metadata request counts", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => columnSetFor(table));
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: `${"SELECT *"} ORDER BY 1` });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `users`");
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[0]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
  });

  function groupedResult(columns: string[]) {
    return [{ columns, rows: columns.map(() => [0]), affected_rows: 0, execution_time_ms: 1 }];
  }

  // Robust under the full-suite worker load (maxWorkers=4): never rely on the
  // default 1s vi.waitFor window for an async enrichment pipeline.
  const waitFor = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 8000, interval: 25 });

  it("R1 — cold single-source grouped query: 1 getColumns, 0 listIndexes", async () => {
    executeMulti.mockResolvedValue(groupedResult(["department", "total"]));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(listIndexes).toHaveBeenCalledTimes(0);
  }, 20000);

  it("R2 — warm repeat of the same grouped query: 0 additional metadata calls", async () => {
    executeMulti.mockResolvedValue(groupedResult(["department", "total"]));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");
    let tab = store.tabs.find((item) => item.id === tabId)!;
    await waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    expect(getColumns).toHaveBeenCalledTimes(1);

    const tabId2 = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId2, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");
    tab = store.tabs.find((item) => item.id === tabId2)!;
    await waitFor(() => expect(tab.resultColumnComments).toBeDefined());
    // The second execution reuses the warm columns cache: no new metadata calls.
    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(listIndexes).toHaveBeenCalledTimes(0);
  });

  it("R3 — cold 3-source grouped query: 3 getColumns, 0 listIndexes", async () => {
    executeMulti.mockResolvedValue(groupedResult(["department", "c1", "c2"]));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId, "SELECT u.department, COUNT(o.id), COUNT(p.id) FROM users u JOIN orders o ON o.user_id = u.id JOIN payments p ON p.user_id = u.id GROUP BY u.department");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    expect(tab.queryEditabilityReason).toBe("aggregation");
    expect(getColumns).toHaveBeenCalledTimes(3);
    expect(listIndexes).toHaveBeenCalledTimes(0);
  }, 20000);

  it("R5 — concurrent same-table grouped enrichments dedupe to 1 getColumns", async () => {
    executeMulti.mockResolvedValue(groupedResult(["department", "total"]));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstTab = store.createTab("mysql-1", "app", "Query");
    const secondTab = store.createTab("mysql-1", "app", "Query");
    await Promise.all([store.executeTabSql(firstTab, "SELECT department, COUNT(*) AS total FROM users GROUP BY department"), store.executeTabSql(secondTab, "SELECT department, COUNT(*) AS total FROM users GROUP BY department")]);
    const first = store.tabs.find((item) => item.id === firstTab)!;
    const second = store.tabs.find((item) => item.id === secondTab)!;
    await waitFor(() => expect(first.resultColumnComments).toBeDefined());
    await waitFor(() => expect(second.resultColumnComments).toBeDefined());
    // Both enrichments resolve users.department; the shared columns
    // cache/in-flight coordinator collapses them to a single getColumns.
    expect(getColumns).toHaveBeenCalledTimes(1);
    expect(listIndexes).toHaveBeenCalledTimes(0);
  });

  it("R4 — multi-source loads run under bounded concurrency (3rd waits for a slot)", async () => {
    const releases: Record<string, (value: ReturnType<typeof columnSetFor> | PromiseLike<ReturnType<typeof columnSetFor>>) => void> = {};
    const started: string[] = [];
    getColumns.mockImplementation((_connectionId: string, _database: string, _schema: string, table: string) => {
      started.push(table);
      return new Promise((resolve) => {
        releases[table] = resolve;
      });
    });
    executeMulti.mockResolvedValue(groupedResult(["department", "c1", "c2"]));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const exec = store.executeTabSql(tabId, "SELECT u.department, COUNT(o.id), COUNT(p.id) FROM users u JOIN orders o ON o.user_id = u.id JOIN payments p ON p.user_id = u.id GROUP BY u.department");

    // The limiter (maxActive=2) admits exactly two column loads; the third
    // source stays queued until a slot frees. Waiting on the condition (not a
    // fixed sleep) keeps this deterministic.
    await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 8000, interval: 25 });
    // The third source has NOT started yet: concurrency is bounded.
    expect(started).toHaveLength(2);

    // Free one slot: the third source then begins.
    releases[started[0]!]!(columnSetFor(started[0]!));
    await vi.waitFor(() => expect(started).toHaveLength(3), { timeout: 8000, interval: 25 });

    // Release everything so the store execution can drain.
    for (const table of started) {
      releases[table]?.(columnSetFor(table));
    }
    await exec;
    expect(listIndexes).toHaveBeenCalledTimes(0);
  });

  it("R10 — metadata failure shows the result, keeps aggregation read-only, and never fetches indexes", async () => {
    getColumns.mockRejectedValue(new Error("metadata unavailable"));
    executeMulti.mockResolvedValue([
      {
        columns: ["department", "total"],
        rows: [["sales", 12]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    await store.executeTabSql(tabId, "SELECT department, COUNT(*) AS total FROM users GROUP BY department");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await waitFor(() => expect(tab.queryEditabilityReason).toBe("aggregation"));

    // Best-effort: no comments claimed, query result preserved, editability
    // unchanged, and no index fallback was triggered by the display failure.
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.tableMeta).toBeUndefined();
    expect(tab.result?.rows.length).toBe(1);
    expect(listIndexes).toHaveBeenCalledTimes(0);
    expect(getColumns).toHaveBeenCalledTimes(1);
  }, 20000);
});
