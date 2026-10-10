import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeMulti: vi.fn(),
  executeQuery: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listObjects: vi.fn(),
  listTables: vi.fn(),
  getConfig: vi.fn(),
  lookupLocalCompletionTables: vi.fn(),
  analyze: vi.fn(),
  preparePlan: vi.fn(),
}));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: mocks.analyze,
  executeMulti: mocks.executeMulti,
  executeQuery: mocks.executeQuery,
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  listObjects: mocks.listObjects,
  listTables: mocks.listTables,
  prepareQueryPaginationExecutionPlan: mocks.preparePlan,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  saveOpenTabsState: vi.fn(),
  cancelQuery: vi.fn(),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConfig,
    lookupLocalCompletionTables: mocks.lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
    metadataGenerationFor: () => 0,
  }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100, autoCalculateTotalRows: false },
  }),
}));

describe("OceanBase Oracle query ROWID preparation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    mocks.getConfig.mockReturnValue({ id: "ob-1", name: "OceanBase", db_type: "oceanbase-oracle", database: "app", query_timeout_secs: 30 });
    mocks.getColumns.mockResolvedValue([{ name: "TASKNAME", data_type: "VARCHAR2(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null }]);
    mocks.listIndexes.mockResolvedValue([]);
    mocks.listTables.mockResolvedValue([]);
    mocks.listObjects.mockResolvedValue([]);
    mocks.lookupLocalCompletionTables.mockReturnValue([{ name: "T_SIPF_DEBUG_LOG", type: "table", schema: "SIPF" }]);
    mocks.analyze.mockResolvedValue({ editable: false, reason: "complex-source" });
    mocks.preparePlan.mockImplementation(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["TASKNAME"], rows: [["sample"]], affected_rows: 0, execution_time_ms: 1 }]);
  });

  async function executedQuery(sql: string) {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("ob-1", "app", "Query");
    store.setAutoCommit(id, true);
    await store.executeTabSql(id, sql);
    expect(mocks.executeMulti).toHaveBeenCalled();
    return { store, id, sql: mocks.executeMulti.mock.calls[0]![2] as string };
  }

  async function emittedSql(sql: string) {
    return (await executedQuery(sql)).sql;
  }

  it("appends a ROWID expression to a single-column projection of a keyless table", async () => {
    const sql = await emittedSql("select a.taskname from sipf.t_sipf_debug_log a");
    expect(sql).toContain('ROWIDTOCHAR(ROWID) AS "__DBX_PK_0"');
    expect(sql).not.toContain('"__DBX_ROWID"');
  });

  it.each(["select * from sipf.t_sipf_debug_log a", "select a.rowid, a.taskname from sipf.t_sipf_debug_log a", "select q.taskname from (select a.taskname from sipf.t_sipf_debug_log a) q"])("preserves queries not needing an extra ROWID: %s", async (sql) => {
    expect(await emittedSql(sql)).toBe(sql);
  });

  it.each(["view", "unknown"])("does not inject ROWID for a %s source", async (type) => {
    mocks.lookupLocalCompletionTables.mockReturnValue(type === "unknown" ? [] : [{ name: "T_SIPF_DEBUG_LOG", type, schema: "SIPF" }]);
    const sql = "select a.taskname from sipf.t_sipf_debug_log a";
    expect(await emittedSql(sql)).toBe(sql);
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("prefers a physical primary key", async () => {
    mocks.getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, is_primary_key: true },
      { name: "TASKNAME", data_type: "VARCHAR2(100)", is_nullable: true, is_primary_key: false },
    ]);
    const sql = await emittedSql("select a.taskname from sipf.t_sipf_debug_log a");
    expect(sql).toContain('"ID" AS "__DBX_PK_0"');
    expect(sql).not.toContain("ROWID");
  });

  it("hides the projected ROWID while retaining two row identities for editing", async () => {
    const { analyzeEditableQueryEditability } = await import("@/lib/sql/sqlAnalysis");
    mocks.analyze.mockImplementation(async (sql: string) => analyzeEditableQueryEditability(sql));
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["TASKNAME", "__DBX_PK_0"],
        rows: [
          ["first", "AAAPr9AAEAAAACXAAA"],
          ["second", "AAAPr9AAEAAAACXAAB"],
        ],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { store, id } = await executedQuery("select a.taskname from sipf.t_sipf_debug_log a");
    const tab = store.tabs.find((item) => item.id === id)!;
    expect(tab.result?.hidden_column_indexes).toEqual([1]);
    expect(tab.result?.rows).toEqual([
      ["first", "AAAPr9AAEAAAACXAAA"],
      ["second", "AAAPr9AAEAAAACXAAB"],
    ]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["TASKNAME", "__DBX_ROWID"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
    expect(tab.queryEditabilityReason).toBeUndefined();
  });

  it.each(["a.", ""])("does not confuse a quoted physical rowid column with the synthetic identity: %s", async (qualifier) => {
    mocks.getColumns.mockResolvedValue([
      { name: "rowid", data_type: "VARCHAR2(100)", is_nullable: true, is_primary_key: false },
      { name: "TASKNAME", data_type: "VARCHAR2(100)", is_nullable: true, is_primary_key: false },
    ]);
    const sql = await emittedSql(`select ${qualifier}"rowid", a.taskname from sipf.t_sipf_debug_log a`);
    expect(sql).toBe(`select ${qualifier}"rowid", a.taskname, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" from sipf.t_sipf_debug_log a`);
  });

  it.each(["select a.rowid as rid, a.taskname from sipf.t_sipf_debug_log a", "select rowid as rid, taskname from sipf.t_sipf_debug_log"])("uses an explicitly selected ROWID as the row identity without hiding it: %s", async (originalSql) => {
    const { analyzeEditableQueryEditability } = await import("@/lib/sql/sqlAnalysis");
    mocks.analyze.mockImplementation(async (sql: string) => analyzeEditableQueryEditability(sql));
    mocks.executeMulti.mockResolvedValue([{ columns: ["RID", "TASKNAME"], rows: [["AAAPr9AAEAAAACXAAA", "first"]], affected_rows: 0, execution_time_ms: 1 }]);
    const { store, id, sql } = await executedQuery(originalSql);
    expect(sql).toBe(originalSql);
    const tab = store.tabs.find((item) => item.id === id)!;
    expect(tab.result?.hidden_column_indexes ?? []).toEqual([]);
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual(["__DBX_ROWID", "TASKNAME"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["__DBX_ROWID"]);
  });

  it.each(["a.", ""])("retains the physical primary key when ROWID is also selected: %s", async (qualifier) => {
    const { analyzeEditableQueryEditability } = await import("@/lib/sql/sqlAnalysis");
    mocks.analyze.mockImplementation(async (sql: string) => analyzeEditableQueryEditability(sql));
    mocks.getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_nullable: false, is_primary_key: true },
      { name: "TASKNAME", data_type: "VARCHAR2(100)", is_nullable: true, is_primary_key: false },
    ]);
    mocks.executeMulti.mockResolvedValue([{ columns: ["RID", "TASKNAME", "__DBX_PK_0"], rows: [["AAAPr9AAEAAAACXAAA", "first", 1]], affected_rows: 0, execution_time_ms: 1 }]);
    const { store, id, sql } = await executedQuery(`select ${qualifier}rowid as rid, a.taskname from sipf.t_sipf_debug_log a`);
    expect(sql).toContain('"ID" AS "__DBX_PK_0"');
    expect(sql).not.toContain("ROWIDTOCHAR");
    const tab = store.tabs.find((item) => item.id === id)!;
    await vi.waitFor(() => expect(tab.querySourceColumns).toEqual([undefined, "TASKNAME", "ID"]));
    expect(tab.tableMeta?.primaryKeys).toEqual(["ID"]);
  });

  it.each([
    "select distinct a.taskname from sipf.t_sipf_debug_log a",
    "select a.taskname, count(*) from sipf.t_sipf_debug_log a group by a.taskname",
    "select a.taskname, b.taskname from sipf.t_sipf_debug_log a join sipf.t_sipf_debug_log b on a.taskname = b.taskname",
    "select rowid, a.taskname from sipf.t_sipf_debug_log a join sipf.t_sipf_debug_log b on a.taskname = b.taskname",
    "select a.taskname from sipf.t_sipf_debug_log a union select b.taskname from sipf.t_sipf_debug_log b",
  ])("does not inject ROWID into an unsafe query: %s", async (sql) => {
    expect(await emittedSql(sql)).toBe(sql);
  });
});
