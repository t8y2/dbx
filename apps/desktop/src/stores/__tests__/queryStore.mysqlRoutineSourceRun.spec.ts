import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #12855: the CREATE statement of a MySQL routine source tab cannot simply be re-run (no CREATE OR REPLACE
// for stored routines), so Run first executes the validate + drop steps of the Save sequence, then runs the tab's own
// statement through the normal pipeline.
const executeMulti = vi.fn();
const executeMultiWithProgress = vi.fn();
const executeQuery = vi.fn();
const buildExecutableObjectSourceStatements = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getConnectionConfig = vi.fn();
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
  buildExecutableObjectSourceStatements,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  executeMulti,
  executeMultiWithProgress,
  executeQuery,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables: vi.fn().mockReturnValue([]),
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings }),
}));

const CREATE = "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`(IN a INT)\nBEGIN\n  SELECT a + 100 AS v;\nEND";
const REPLACE_SEQUENCE = [
  "DROP PROCEDURE IF EXISTS `app`.`dbx_routine_check_1`;",
  "CREATE DEFINER=`root`@`%` PROCEDURE `dbx_routine_check_1`(IN a INT)\nBEGIN\n  SELECT a + 100 AS v;\nEND;",
  "DROP PROCEDURE IF EXISTS `app`.`dbx_routine_check_1`;",
  "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;",
  `${CREATE};`,
];

describe("queryStore MySQL routine source Run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    buildExecutableObjectSourceStatements.mockResolvedValue(REPLACE_SEQUENCE);
    analyzeEditableQueryEditability.mockResolvedValue({ editable: false, reason: "not-select" });
    executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });
    executeMulti.mockResolvedValue([{ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 }]);
    executeMultiWithProgress.mockResolvedValue([
      { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 },
      { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 },
    ]);
  });

  async function openSourceTab(sql: string, objectType: "PROCEDURE" | "FUNCTION" | "VIEW" = "PROCEDURE", name = "refresh_cache") {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.openObjectSourceTab({ connectionId: "mysql-1", database: "app", title: `Source - ${name}`, schema: "app", sql, objectSource: { schema: "app", name, objectType } });
    return { store, id };
  }

  it("validates and drops the existing routine before running the tab's own CREATE unchanged", async () => {
    const { store, id } = await openSourceTab(CREATE);

    await store.executeTabSql(id, CREATE);

    expect(buildExecutableObjectSourceStatements).toHaveBeenCalledWith({ databaseType: "mysql", objectType: "PROCEDURE", schema: "app", name: "refresh_cache", source: CREATE });
    expect(executeQuery.mock.calls.map((call) => call[2])).toEqual(REPLACE_SEQUENCE.slice(0, -1));
    expect(executeQuery.mock.calls.every((call) => call[0] === "mysql-1" && call[1] === "app")).toBe(true);
    // The CREATE itself goes through the normal pipeline exactly as typed, after every preparation step.
    expect(executeMulti).toHaveBeenCalledTimes(1);
    expect(executeMulti.mock.calls[0]?.[2]).toBe(CREATE);
    expect(Math.max(...executeQuery.mock.invocationCallOrder)).toBeLessThan(executeMulti.mock.invocationCallOrder[0]!);
    expect(store.tabs.find((tab) => tab.id === id)?.result?.execution_error).not.toBe(true);
  });

  it("covers functions with the same flow", async () => {
    const createFunction = "CREATE FUNCTION `active_count`() RETURNS int DETERMINISTIC RETURN 1";
    const sequence = ["DROP FUNCTION IF EXISTS `app`.`dbx_routine_check_2`;", "CREATE FUNCTION `dbx_routine_check_2`() RETURNS int DETERMINISTIC RETURN 1;", "DROP FUNCTION IF EXISTS `app`.`dbx_routine_check_2`;", "DROP FUNCTION IF EXISTS `app`.`active_count`;", `${createFunction};`];
    buildExecutableObjectSourceStatements.mockResolvedValue(sequence);
    const { store, id } = await openSourceTab(createFunction, "FUNCTION", "active_count");

    await store.executeTabSql(id, createFunction);

    expect(executeQuery.mock.calls.map((call) => call[2])).toEqual(sequence.slice(0, -1));
    expect(executeMulti.mock.calls[0]?.[2]).toBe(createFunction);
  });

  it("leaves a plain query tab alone, so CREATE keeps its normal semantics there", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(id, CREATE);

    expect(buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeMulti.mock.calls[0]?.[2]).toBe(CREATE);
  });

  it("leaves scripts with other statements and other routines to run exactly as written", async () => {
    const { store, id } = await openSourceTab(CREATE);

    const script = `${CREATE};\nCALL refresh_cache(1);`;
    await store.executeTabSql(id, script);
    await store.executeTabSql(id, "CREATE PROCEDURE `refresh_cache_v2`() BEGIN SELECT 1; END");
    await store.executeTabSql(id, "CALL refresh_cache(1)");

    expect(buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeMultiWithProgress.mock.calls.map((call) => call[2])).toEqual([script]);
    expect(executeMulti.mock.calls.map((call) => call[2])).toEqual(["CREATE PROCEDURE `refresh_cache_v2`() BEGIN SELECT 1; END", "CALL refresh_cache(1)"]);
  });

  it("does not apply to non-routine source tabs or other databases", async () => {
    const view = await openSourceTab("ALTER VIEW `v` AS SELECT 1", "VIEW", "v");
    await view.store.executeTabSql(view.id, "ALTER VIEW `v` AS SELECT 1");

    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "Postgres", db_type: "postgres", database: "app", query_timeout_secs: 30 });
    const postgres = await openSourceTab(CREATE);
    await postgres.store.executeTabSql(postgres.id, CREATE);

    expect(buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("still runs the statement when the preparation fails, so the real error is reported", async () => {
    executeQuery.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("You have an error in your SQL syntax"));
    executeMulti.mockResolvedValue([{ columns: ["Error"], rows: [["You have an error in your SQL syntax near 'SELEC'"]], affected_rows: 0, execution_time_ms: 1, execution_error: true }]);
    const { store, id } = await openSourceTab(CREATE);

    await store.executeTabSql(id, CREATE);

    // Validation failed at step 2, so the old routine's DROP never ran and the statement itself reports the error.
    expect(executeQuery).toHaveBeenCalledTimes(2);
    expect(executeMulti).toHaveBeenCalledTimes(1);
    expect(executeMulti.mock.calls[0]?.[2]).toBe(CREATE);
    expect(store.tabs.find((tab) => tab.id === id)?.result?.rows[0]?.[0]).toContain("syntax");
  });

  it("still runs the statement when the backend cannot build the replace sequence", async () => {
    buildExecutableObjectSourceStatements.mockRejectedValue(new Error("backend unavailable"));
    const { store, id } = await openSourceTab(CREATE);

    await store.executeTabSql(id, CREATE);

    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeMulti).toHaveBeenCalledTimes(1);
  });
});
