// @vitest-environment happy-dom
// Behavioural coverage for the FK drill-through wiring in useNavigationTargets
// (review #3): the restore point contract — capture sort/page/where before the
// pane is rewritten, withdraw the entry when the open fails, keep the editor SQL
// untouched on the query-tab path, and restore the captured state on Back.
// The DataGrid-side routing decision is behaviour-tested via
// foreignKeyDrillRouting in dataGridForeignKeyNavigation.spec.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(),
  cancelQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  executeMulti: vi.fn(),
  executeMultiWithProgress: vi.fn(),
  getConfig: vi.fn(),
  getColumns: vi.fn(),
  loadEditorSettings: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveEditorSettings: vi.fn(),
  saveOpenTabsState: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key, locale: { value: "en" } } }),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: vi.fn(async () => ({ editable: false, reason: "not-editable" })),
  buildTableSelectSql: mocks.buildTableSelectSql,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMultiWithProgress,
  getColumns: mocks.getColumns,
  listIndexes: vi.fn(async () => []),
  listReferenceKeys: vi.fn(async () => []),
  loadEditorSettings: mocks.loadEditorSettings,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveEditorSettings: mocks.saveEditorSettings,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
    recordConnectionLostError: vi.fn(),
    metadataGenerationFor: () => 0,
    connectionIdentifierQuote: () => "`",
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      autoCalculateTotalRows: false,
      pageSize: 100,
      tableOpenPageSize: 100,
      generateSqlIncludeDatabaseName: false,
      dataGridOrderByVisible: true,
      tableOpenSortMode: "none",
      dataTabReuseMode: "active-tab",
    },
    updateEditorSettings: vi.fn(),
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { useQueryStore } from "@/stores/queryStore";
import { foreignKeyDrillBackEntries } from "@/lib/dataGrid/foreignKeyDrillBack";

function resultOf(rows: unknown[][], columns = ["value"]): any {
  return { columns, rows, affected_rows: rows.length, execution_time_ms: 1 };
}

function navigation() {
  return useNavigationTargets({ showFieldLineageDialog: { value: false }, showDatabaseSearchDialog: { value: false }, showDiagramDialog: { value: false } });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.cancelQuery.mockResolvedValue(true);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.loadEditorSettings.mockResolvedValue({});
  mocks.saveEditorSettings.mockResolvedValue(undefined);
  mocks.saveOpenTabsState.mockResolvedValue(undefined);
  mocks.getColumns.mockResolvedValue([]);
  mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
  // executeTabSql's pagination plan: pass SQL through untouched
  mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options: { sql: string }) => ({
    sqlToExecute: options.sql,
    pageSql: undefined,
    pageLimit: undefined,
    pageOffset: undefined,
    countSql: undefined,
    useAgentResultSession: false,
  }));
  // buildTableSelectSql: pass the caller's pieces through as SQL text so the
  // captured orderBy/whereInput/limit surface in the executed SQL string
  mocks.buildTableSelectSql.mockImplementation(async (options: any) => {
    const parts: string[] = ["SELECT * FROM", options.schema ? `${options.schema}.` : "", options.tableName];
    if (options.whereInput) parts.push("WHERE", options.whereInput);
    if (options.orderBy) parts.push("ORDER BY", options.orderBy);
    parts.push("LIMIT", String(options.limit ?? 100));
    if (options.page?.offset) parts.push("OFFSET", String(options.page.offset));
    return parts.join(" ");
  });
  // executeTabSql path: plan passes SQL through, executor returns one result
  mocks.executeMultiWithProgress.mockImplementation(async (_c: string, _d: string, sql: string, onProgress: (p: any) => void) => {
    const result = resultOf([[sql]]);
    onProgress({ executionId: "exec-1", statementIndex: 0, completed: 1, total: 1, success: true, executionTimeMs: 1, affectedRows: 0 });
    return [result];
  });
  mocks.executeMulti.mockResolvedValue([resultOf([[1]])]);
});

describe("useNavigationTargets FK drill wiring (openTableTarget restore points)", () => {
  it("captures the source tab's live where/sort/page before rewriting it and restores them on Back", async () => {
    const query = useQueryStore();
    const { openTableTarget } = navigation();
    const sourceId = query.createTab("mysql-1", "app", "orders", "data", "app");
    query.setTableMeta(sourceId, { database: "app", schema: "app", tableName: "orders", tableType: "TABLE", columns: [{ name: "id", data_type: "int", is_nullable: false, is_primary_key: true, extra: null, column_default: null }], primaryKeys: ["id"] });
    const sourceTab = query.tabs.find((tab) => tab.id === sourceId)!;
    // the live state Back must not lose (review #3): filter, sort, page
    sourceTab.whereInput = "`status` = 2";
    sourceTab.orderByInput = "`created_at` DESC";
    sourceTab.structuredOrderByInput = "`region` ASC";
    sourceTab.resultPageLimit = 200;
    sourceTab.resultPageOffset = 400;
    sourceTab.result = resultOf([[1, 2]], ["id", "status"]);

    const target = { connectionId: "mysql-1", database: "app", schema: "app", tableName: "customers", tableType: "TABLE", whereInput: "`id` = 7" };
    await openTableTarget(target, { reuseTabId: sourceId, drillBack: true });

    // in-place: the same tab now shows the target table
    expect(sourceTab.tableMeta?.tableName).toBe("customers");
    // the restore point carries the captured state
    const entries = foreignKeyDrillBackEntries(sourceId);
    expect(entries).toHaveLength(1);
    expect(entries[0].restore.kind).toBe("tableTarget");
    if (entries[0].restore.kind === "tableTarget") {
      expect(entries[0].restore.target).toMatchObject({ tableName: "orders", whereInput: "`status` = 2", orderByInput: "`created_at` DESC", structuredOrderByInput: "`region` ASC", page: { limit: 200, offset: 400 } });
    }

    // Back: restore replays the captured state (skip saved defaults, keep sort/page)
    await openTableTarget(entries[0].restore.kind === "tableTarget" ? entries[0].restore.target : target, { reuseTabId: sourceId, restore: true });
    expect(sourceTab.tableMeta?.tableName).toBe("orders");
    expect(sourceTab.whereInput).toBe("`status` = 2");
    // manual and structured sort stay in their own fields (SQL uses the combination)
    expect(sourceTab.orderByInput).toBe("`created_at` DESC");
    expect(sourceTab.structuredOrderByInput).toBe("`region` ASC");
    // the restored SELECT carries the captured sort and page
    const executedSqls = mocks.executeMulti.mock.calls.map((call) => call[2]);
    const lastSql = executedSqls[executedSqls.length - 1];
    expect(lastSql).toContain("ORDER BY `created_at` DESC, `region` ASC");
    expect(lastSql).toContain("`status` = 2");
    expect(lastSql).toContain("LIMIT 200");
  });

  it("withdraws the restore point when the in-place open fails before the first execute", async () => {
    const query = useQueryStore();
    const { openTableTarget } = navigation();
    const sourceId = query.createTab("mysql-1", "app", "orders", "data", "app");
    query.setTableMeta(sourceId, { database: "app", schema: "app", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    const sourceTab = query.tabs.find((tab) => tab.id === sourceId)!;
    sourceTab.whereInput = undefined;
    sourceTab.result = resultOf([[1]], ["id"]);

    // connection failure during the jump's prepare phase
    mocks.ensureConnected.mockRejectedValue(new Error("connection refused"));
    const target = { connectionId: "mysql-1", database: "app", schema: "app", tableName: "customers", tableType: "TABLE", whereInput: "`id` = 7" };
    await openTableTarget(target, { reuseTabId: sourceId, drillBack: true });

    // no dead entry: the failed open must withdraw the restore point it pushed.
    // (The tab still shows the placeholder target identity + error result — the
    // synchronous identity stamp before connect is by design, issue #3613.)
    expect(foreignKeyDrillBackEntries(sourceId)).toHaveLength(0);
    expect(sourceTab.tableMeta?.tableName).toBe("customers");
  });

  it("does not push a restore point when the tab cannot be reused (new-tab fallback)", async () => {
    const query = useQueryStore();
    const { openTableTarget } = navigation();
    const sourceId = query.createTab("mysql-1", "app", "orders", "data", "app");
    query.setTableMeta(sourceId, { database: "app", schema: "app", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    // pinned tabs are never reused in place
    const sourceTab = query.tabs.find((tab) => tab.id === sourceId)!;
    sourceTab.pinned = true;

    const target = { connectionId: "mysql-1", database: "app", schema: "app", tableName: "customers", tableType: "TABLE" };
    await openTableTarget(target, { reuseTabId: sourceId, drillBack: true });
    expect(foreignKeyDrillBackEntries(sourceId)).toHaveLength(0);
    // the source tab is untouched; a new tab was created for the target
    expect(sourceTab.tableMeta?.tableName).toBe("orders");
    expect(query.tabs.some((tab) => tab.tableMeta?.tableName === "customers")).toBe(true);
  });
});

describe("useNavigationTargets FK drill wiring (executeTableTargetInQueryTab)", () => {
  it("captures the previous result SQL and page, executes the lookup in the results pane, and leaves the editor SQL untouched", async () => {
    const query = useQueryStore();
    const { executeTableTargetInQueryTab, executeSqlInQueryTabResults } = navigation();
    const tabId = query.createTab("mysql-1", "app", "Query", "query");
    const tab = query.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT * FROM orders";
    tab.lastExecutedSql = "SELECT * FROM orders LIMIT 200 OFFSET 400";
    tab.resultBaseSql = "SELECT * FROM orders LIMIT 200 OFFSET 400";
    tab.resultPageLimit = 200;
    tab.resultPageOffset = 400;
    tab.result = resultOf([[1, 2]], ["id", "customer_id"]);

    const target = { connectionId: "mysql-1", database: "app", schema: "app", tableName: "customers", tableType: "TABLE", whereInput: "`id` = 7" };
    await executeTableTargetInQueryTab(target, { tabId, drillBack: true });

    // the lookup ran in the results pane; the editor SQL never changed
    expect(tab.sql).toBe("SELECT * FROM orders");
    const executedSqls = mocks.executeMulti.mock.calls.map((call) => call[2]);
    expect(executedSqls.some((sql) => typeof sql === "string" && sql.includes("customers"))).toBe(true);
    // resultBaseSql now describes the drill result (Back validates against it)
    expect(tab.resultBaseSql).not.toBe("SELECT * FROM orders LIMIT 200 OFFSET 400");

    // the restore point captured the pre-jump SQL and page
    const entries = foreignKeyDrillBackEntries(tabId);
    expect(entries).toHaveLength(1);
    expect(entries[0].restore).toMatchObject({ kind: "queryResult", sql: "SELECT * FROM orders LIMIT 200 OFFSET 400", page: { limit: 200, offset: 400 } });

    // Back: re-runs the previous SQL with the captured page in the results pane
    await executeSqlInQueryTabResults(tabId, entries[0].restore.kind === "queryResult" ? entries[0].restore.sql : "", { pagination: entries[0].restore.kind === "queryResult" ? entries[0].restore.page : undefined });
    const backSql = mocks.executeMulti.mock.calls[mocks.executeMulti.mock.calls.length - 1][2];
    expect(backSql).toBe("SELECT * FROM orders LIMIT 200 OFFSET 400");
    // editor SQL is still the user's query
    expect(tab.sql).toBe("SELECT * FROM orders");
  });

  it("withdraws the restore point when the in-pane execution never lands a result (review #3)", async () => {
    const query = useQueryStore();
    const { executeTableTargetInQueryTab } = navigation();
    const tabId = query.createTab("mysql-1", "app", "Query", "query");
    const tab = query.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT * FROM orders";
    tab.lastExecutedSql = "SELECT * FROM orders";
    tab.resultBaseSql = "SELECT * FROM orders";
    tab.result = resultOf([[1, 2]], ["id", "customer_id"]);

    // executeTabSql surfaces failures as an execution_error result — the
    // drill result never landed, so the pane was never rewritten
    mocks.executeMulti.mockRejectedValue(new Error("boom"));
    mocks.executeMultiWithProgress.mockRejectedValue(new Error("boom"));
    const target = { connectionId: "mysql-1", database: "app", schema: "app", tableName: "customers", tableType: "TABLE", whereInput: "`id` = 7" };
    await executeTableTargetInQueryTab(target, { tabId, drillBack: true });
    expect(foreignKeyDrillBackEntries(tabId)).toHaveLength(0);
  });
});
