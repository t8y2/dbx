import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const dorisColumns = [column("id", "主键ID"), column("user_name", "用户名称"), column("created_at", "创建时间"), column("extra_field", null)];

describe("queryStore Doris qualified-table metadata target", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    // Doris connection WITHOUT a default database: the query tab has no
    // execution database either, so the only source of the table's namespace
    // is the database explicitly qualified in the SQL (`dbx6590_test.tbl`).
    getConnectionConfig.mockReturnValue({ id: "doris-1", name: "Doris", db_type: "doris", database: null, query_timeout_secs: 30 });
    getColumns.mockResolvedValue(dorisColumns);
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        // `dbx6590_test.dbx_comment_test` → the qualified database lands in
        // `schema` (MySQL-family two-part names), matching the Rust parser.
        schema: "dbx6590_test",
        schemaQuoted: false,
        tableName: "dbx_comment_test",
        tableNameQuoted: false,
        tableAlias: undefined,
        selectStar: true,
        columns: [],
        multiSource: false,
        allowInsertDelete: true,
      },
    });
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: `${"SELECT *"} ORDER BY 1` });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `dbx6590_test`.`dbx_comment_test`");
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "user_name", "created_at", "extra_field"],
        rows: [[1, "alice", "2026-01-01 10:00:00", 100]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
    executeQuery.mockResolvedValue({
      columns: ["id", "user_name", "created_at", "extra_field"],
      rows: [[1, "alice", "2026-01-01 10:00:00", 100]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("sends the SQL-qualified database in `schema` so the backend can resolve the column lookup", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("doris-1", "", "Query");

    await store.executeTabSql(tabId, "SELECT * FROM dbx6590_test.dbx_comment_test");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta).toBeDefined(), { timeout: 8000 });

    // The metadata request carries the empty execution database plus the
    // qualified database as `schema`. The backend's MySQL-compatible
    // show-metadata path resolves the effective database from `schema`
    // (fixes #6590); the query-result header then consumes tableMeta columns.
    expect(getColumns).toHaveBeenCalledWith("doris-1", "", "dbx6590_test", "dbx_comment_test", undefined);

    // Comments must flow into tableMeta so the data grid can display them.
    const comments = new Map((tab.tableMeta?.columns ?? []).map((c) => [c.name, c.comment]));
    expect(comments.get("id")).toBe("主键ID");
    expect(comments.get("user_name")).toBe("用户名称");
    expect(comments.get("created_at")).toBe("创建时间");
    // Uncommented columns stay empty — no placeholder in the header.
    expect(comments.get("extra_field")).toBeNull();
  }, 15000);
});
