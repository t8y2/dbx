import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "@/types/database";

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const listTables = vi.fn();
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
  beginManualTransaction: vi.fn().mockResolvedValue("txn-1"),
  cancelQuery: vi.fn().mockResolvedValue(false),
  executeInManualTransaction: vi.fn(),
  executeMulti,
  executeQuery,
  getColumns,
  listIndexes,
  listObjects,
  listTables,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
    metadataGenerationFor: () => 0,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings,
  }),
}));

// #10567: the SELECT resolves through the server's case folding (`FROM
// MSS_CHECK_SALES_ITEM` reads `mss_check_sales_item`), but the grid save
// re-quotes the SQL-text spelling — `term."MSS_CHECK_SALES_ITEM"` — which no
// longer resolves. The write identity carried by tableMeta must use the folded
// spelling for PostgreSQL-compatible engines.
function column(name: string, isPrimaryKey: boolean): ColumnInfo {
  return { name, data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: isPrimaryKey, extra: null };
}

function mockAnalysis(overrides: Record<string, unknown> = {}) {
  analyzeEditableQueryEditability.mockResolvedValue({
    editable: true,
    analysis: {
      schema: "term",
      tableName: "MSS_CHECK_SALES_ITEM",
      tableNameQuoted: false,
      selectStar: false,
      columns: [{ sourceName: "price", resultName: "price", expression: "price" }],
      ...overrides,
    },
  });
}

describe("query store folds unquoted PostgreSQL table identities for writes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getColumns.mockResolvedValue([column("check_sales_item_id", true), column("price", false)]);
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    listTables.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    buildSortedQuerySql.mockImplementation(async (options) => ({ ok: true, sql: options.originalSql }));
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM t");
    executeMulti.mockResolvedValue([{ columns: ["price"], rows: [["94.1"]], affected_rows: 0, execution_time_ms: 1 }]);
    executeQuery.mockResolvedValue({ columns: ["row_count"], rows: [[0]], affected_rows: 0, execution_time_ms: 1 });
    mockAnalysis();
  });

  it("folds the unquoted SQL-text table name so the save targets the stored relation", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PG", db_type: "postgres", database: "dbx", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "dbx", "Query");

    await store.executeTabSql(tabId, "SELECT price FROM MSS_CHECK_SALES_ITEM");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());

    expect(tab.tableMeta?.tableName).toBe("mss_check_sales_item");
    expect(tab.tableMeta?.schema).toBe("term");
    // The metadata request must have gone out with the folded spelling too.
    expect(getColumns).toHaveBeenCalledWith("pg-1", "dbx", "term", "mss_check_sales_item", undefined);
  }, 10_000);

  it("keeps quoted SQL-text identifiers exact", async () => {
    getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PG", db_type: "postgres", database: "dbx", query_timeout_secs: 30 });
    mockAnalysis({ tableNameQuoted: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "dbx", "Query");

    await store.executeTabSql(tabId, 'SELECT price FROM "MSS_CHECK_SALES_ITEM"');
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());

    expect(tab.tableMeta?.tableName).toBe("MSS_CHECK_SALES_ITEM");
  }, 10_000);

  it("leaves non-PostgreSQL-compatible engines untouched (kingbase folds independently)", async () => {
    getConnectionConfig.mockReturnValue({ id: "kb-1", name: "Kingbase", db_type: "kingbase", database: "dbx", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("kb-1", "dbx", "Query");

    await store.executeTabSql(tabId, "SELECT price FROM MSS_CHECK_SALES_ITEM");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());

    expect(tab.tableMeta?.tableName).toBe("MSS_CHECK_SALES_ITEM");
  }, 10_000);

  it("folds jdbc connections whose dialect infers a PostgreSQL-compatible engine", async () => {
    getConnectionConfig.mockReturnValue({
      id: "jdbc-1",
      name: "JDBC PG",
      db_type: "jdbc",
      database: "dbx",
      query_timeout_secs: 30,
      connection_string: "jdbc:postgresql://db.example.com:5432/dbx",
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("jdbc-1", "dbx", "Query");

    await store.executeTabSql(tabId, "SELECT price FROM MSS_CHECK_SALES_ITEM");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined());

    expect(tab.tableMeta?.tableName).toBe("mss_check_sales_item");
  }, 10_000);
});
