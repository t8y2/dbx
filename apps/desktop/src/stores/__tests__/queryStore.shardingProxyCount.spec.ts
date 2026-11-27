import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const prepareQueryPaginationExecutionPlan = vi.fn();

const editorSettings = {
  pageSize: 5000,
  autoCalculateTotalRows: true,
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

describe("queryStore ShardingSphere-Proxy count forwarding (#15723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    getColumns.mockResolvedValue([]);
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "aggregation" });
  });

  it("forwards serverVersion and serverComment to pagination planning and skips background COUNT when omitted", async () => {
    getConnectionConfig.mockReturnValue({
      id: "sharding-1",
      name: "ShardingSphere",
      db_type: "mysql",
      database: "parking_ext",
      query_timeout_secs: 30,
      database_info: {
        productName: "MySQL",
        productVersion: "8.0.36-ShardingSphere-Proxy 5.5.3",
        serverComment: "ShardingSphere-Proxy",
      },
    });
    const sql = "SELECT SUM(order_fee - paid_fee) AS arrears_fee, plate_number, plate_color FROM order_info GROUP BY plate_number, plate_color";
    prepareQueryPaginationExecutionPlan.mockResolvedValue({
      sqlToExecute: `${sql} ORDER BY 2, 3 LIMIT 5000;`,
      pageSql: `${sql} ORDER BY 2, 3 LIMIT 5000;`,
      pageLimit: 5000,
      pageOffset: 0,
      countSql: undefined,
      useAgentResultSession: false,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["arrears_fee", "plate_number", "plate_color"],
        rows: Array.from({ length: 5000 }, (_, i) => [100 + i, `P${i}`, "1"]),
        affected_rows: 5000,
        execution_time_ms: 120,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sharding-1", "parking_ext", "Query");

    await store.executeTabSql(tabId, sql);

    expect(prepareQueryPaginationExecutionPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "mysql",
        serverVersion: "8.0.36-ShardingSphere-Proxy 5.5.3",
        serverComment: "ShardingSphere-Proxy",
      }),
    );
    expect(executeQuery).not.toHaveBeenCalled();

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.resultCountSql).toBeUndefined();
    expect(tab.resultTotalRowCount).toBeUndefined();
    expect(tab.resultTotalRowCountLoading).toBe(false);
  });
});
