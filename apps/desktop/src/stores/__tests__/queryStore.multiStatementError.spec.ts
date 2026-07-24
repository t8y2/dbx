import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeEditableQueryEditability: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  executeMulti: vi.fn(),
  getConnectionConfig: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyzeEditableQueryEditability,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { autoCalculateTotalRows: false, pageSize: 100, continueOnErrorOnBatch: false },
  }),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore multi-statement errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (options) => ({
      sqlToExecute: options.sql,
      pageSql: undefined,
      pageLimit: undefined,
      pageOffset: undefined,
      countSql: undefined,
      useAgentResultSession: false,
    }));
    mocks.analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "multiple-statements" });
  });

  it("opens the first error result from a mixed result batch", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], execution_error: true, rows: [["no such table: missing"]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT * FROM missing");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.result?.columns).toEqual(["Error"]);
  });

  it("opens a later PostgreSQL error result from a mixed result batch", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "postgres-1",
      name: "PostgreSQL",
      db_type: "postgres",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValue([
      { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index: 0 },
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["Error"], execution_error: true, rows: [["relation missing_table does not exist"]], affected_rows: 0, execution_time_ms: 1, statement_index: 2 },
      { columns: ["after_error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 3 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("postgres-1", "app", "Query");

    await store.executeTabSql(tabId, "BEGIN; SELECT 1 AS value; SELECT * FROM missing_table");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(2);
    expect(tab.result).toMatchObject({
      columns: ["Error"],
      execution_error: true,
      rows: [["relation missing_table does not exist"]],
    });
    expect(tab.results).toHaveLength(4);
  });

  it("invalidates only the executing Oracle tab after successful CURRENT_SCHEMA changes", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
      query_timeout_secs: 30,
    });
    mocks.executeMulti
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }])
      .mockResolvedValueOnce([{ columns: ["Error"], rows: [["schema missing"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }])
      .mockResolvedValueOnce([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabA = store.createTab("oracle-1", "ORCL", "Tab A");
    const tabB = store.createTab("oracle-1", "ORCL", "Tab B");

    await store.executeTabSql(tabA, "ALTER SESSION SET CURRENT_SCHEMA = REPORTING");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(1);
    expect(store.tabs.find((tab) => tab.id === tabB)?.completionContextVersion).toBeUndefined();

    await store.executeTabSql(tabA, "/* retry */ ALTER SESSION SET CURRENT_SCHEMA = MISSING");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(1);

    await store.executeTabSql(tabA, "-- switch back\nALTER SESSION SET CURRENT_SCHEMA = APP");
    expect(store.tabs.find((tab) => tab.id === tabA)?.completionContextVersion).toBe(2);
    expect(mocks.executeMulti.mock.calls.map((call) => call[5]?.clientSessionId)).toEqual([tabA, tabA, tabA]);
  });

  it("invalidates Oracle completion metadata when clearing a tab schema resets its session", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCL",
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCL", "Oracle", "query", "REPORTING");

    store.updateSchema(tabId, undefined);

    expect(store.tabs.find((tab) => tab.id === tabId)?.completionContextVersion).toBe(1);
  });

  it("preserves the selected statement's absolute editor range", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const selectedSql = "SELECT * FROM users";

    await store.executeTabSql(tabId, selectedSql, { sourceOffset: 21 });

    expect(store.tabs.find((item) => item.id === tabId)?.result).toMatchObject({
      sourceStatement: selectedSql,
      sourceFrom: 21,
      sourceTo: 40,
    });
  });

  it("uses explicit statement indexes for selected multi-statement ranges", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["Error"], rows: [["failed"]], affected_rows: 0, execution_time_ms: 1, execution_error: true, statement_index: 2 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const selectedSql = "SELECT 1; SELECT 2; SELECT bad";

    await store.executeTabSql(tabId, selectedSql, { sourceOffset: 10 });

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.results?.[0]).toMatchObject({
      sourceStatement: "SELECT 2",
      sourceFrom: 20,
      sourceTo: 28,
      statement_index: 1,
    });
    expect(tab.results?.[1]).toMatchObject({
      sourceStatement: "SELECT bad",
      sourceFrom: 30,
      sourceTo: 40,
      statement_index: 2,
      execution_error: true,
    });
  });

  it("uses Name comments for their indexed query results", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, statement_index: 0 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const sql = "-- Name: Users\nSELECT * FROM users;\n-- name : Orders\nSELECT * FROM orders";

    await store.executeTabSql(tabId, sql);

    expect(store.tabs.find((item) => item.id === tabId)?.results?.map((result) => result.sourceLabel)).toEqual(["Orders", "Users"]);
  });

  it("does not promote an unmarked Error alias without type metadata as a batch failure", async () => {
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT 2 AS Error");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.result?.columns).toEqual(["value"]);
  });

  it("does not apply the MySQL result heuristic to a JDBC MySQL dialect", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "JDBC MySQL",
      db_type: "jdbc",
      connection_string: "jdbc:mysql://localhost:3306/app",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti.mockResolvedValue([
      { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1 AS value; SELECT 2 AS Error");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.activeResultIndex).toBe(0);
    expect(tab.result?.columns).toEqual(["value"]);
  });

  it("passes continueOnError=false from settings to executeMulti by default", async () => {
    mocks.executeMulti.mockResolvedValue([{ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT 1");

    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", "SELECT 1", undefined, expect.any(String), expect.objectContaining({ continueOnError: false }));
  });
});
