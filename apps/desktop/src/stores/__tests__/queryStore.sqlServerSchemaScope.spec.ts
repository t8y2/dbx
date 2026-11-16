import { createPinia, setActivePinia } from "pinia";
import { serializeOpenTabs } from "@/lib/app/openTabsPersistence";
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

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

/** The 4th positional argument of executeMulti is the tab's schema. */
function executedSchema(): string | undefined {
  const call = mocks.executeMulti.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![3] as string | undefined;
}

describe("SQL Server 页签 Schema 的显式作用域", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({ id: "sql-1", name: "SQL Server", db_type: "sqlserver", database: "app", query_timeout_secs: 30 });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    mocks.executeMultiWithProgress.mockImplementation(async (connectionId, database, sql, onProgress, schema, options) => {
      const results = await mocks.executeMulti(connectionId, database, sql, schema, options?.executionId, options);
      results.forEach((result: any, index: number) => {
        onProgress({
          executionId: options?.executionId,
          statementIndex: index,
          completed: index + 1,
          total: results.length,
          success: result.execution_error !== true,
          executionTimeMs: result.execution_time_ms,
          affectedRows: result.affected_rows,
          error: result.error,
        });
      });
      return results;
    });
  });

  it("隐式 Schema（连接默认/恢复的页签/保存的 SQL）不参与 SQL Server 改写", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    // createTab 不传 schemaQualifiesSql 等价于恢复/默认来源。
    const tabId = store.createTab("sql-1", "app", "Query", "query", "core");
    await store.executeTabSql(tabId, "SELECT * FROM products");

    expect(executedSchema()).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === tabId)?.schema).toBe("core");
  });

  it("工具栏显式选择 Schema 后仍按它改写（保留 #8951）", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sql-1", "app", "Query", "query");

    store.updateSchema(tabId, "core", { schemaQualifiesSql: true });
    await store.executeTabSql(tabId, "SELECT * FROM products");

    expect(executedSchema()).toBe("core");
  });

  it("侧栏 Schema 节点新建查询时同样是显式作用域", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sql-1", "app", "Query", "query", "core", undefined, undefined, { schemaQualifiesSql: true });
    await store.executeTabSql(tabId, "SELECT * FROM products");

    expect(executedSchema()).toBe("core");
  });

  it.each([true, false])("复制页签保留 Schema 的执行作用域（显式选择：%s）", async (explicit) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const sql = "UPDATE products SET status = 'done' WHERE id = 1";
    const tabId = store.createTab("sql-1", "app", "Query", "query", "core", sql);
    if (explicit) store.updateSchema(tabId, "core", { schemaQualifiesSql: true });
    const expectedSchema = explicit ? "core" : undefined;
    await store.executeTabSql(tabId, sql);
    expect(executedSchema()).toBe(expectedSchema);

    store.duplicateTab(tabId);
    const duplicated = store.tabs.find((tab) => tab.id !== tabId)!;
    expect(duplicated.schema).toBe("core");
    expect(duplicated.sql).toBe(sql);
    await store.executeTabSql(duplicated.id, duplicated.sql);

    expect(executedSchema()).toBe(expectedSchema);
  });

  it("清空或切换数据库会同时清掉显式作用域", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sql-1", "app", "Query", "query", "core", undefined, undefined, { schemaQualifiesSql: true });
    store.updateDatabase(tabId, "other");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.schema).toBeUndefined();
    expect(tab.schemaQualifiesSql).toBeUndefined();

    store.updateSchema(tabId, "core", { schemaQualifiesSql: true });
    store.updateSchema(tabId, undefined);
    expect(tab.schemaQualifiesSql).toBeUndefined();
  });

  it("非 SQL Server 数据库不受显式作用域限制", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "pg-1", name: "PG", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query", "query", "reporting");
    await store.executeTabSql(tabId, 'SELECT * FROM "users"');

    expect(executedSchema()).toBe("reporting");
  });

  it("显式作用域不随页签持久化，恢复后回到服务器默认解析", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sql-1", "app", "Query", "query", "core", undefined, undefined, { schemaQualifiesSql: true });
    const tab = store.tabs.find((item) => item.id === tabId)!;

    expect(serializeOpenTabs([tab])[0]).not.toHaveProperty("schemaQualifiesSql");
  });
});
