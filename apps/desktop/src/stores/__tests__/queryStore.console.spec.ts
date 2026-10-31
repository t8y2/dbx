import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";

const mocks = vi.hoisted(() => ({
  executeMulti: vi.fn(),
  subscribe: vi.fn(),
  cleanup: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  editorSettings: { pageSize: 100, autoCalculateTotalRows: false, queryResultMaxRowsEnabled: false, queryResultMaxRows: 1000, confirmDangerousSqlExecution: false },
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({
  executeMulti: mocks.executeMulti,
  executeMultiWithProgress: mocks.executeMulti,
  subscribeQueryMessages: mocks.subscribe,
  cancelQuery: mocks.cancelQuery,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
  unlockConnectionWrites: vi.fn().mockResolvedValue(0),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false })),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected.mockResolvedValue(undefined),
    getConfig: mocks.getConfig,
    lookupLocalCompletionTables: () => [],
    recordConnectionLostError: vi.fn(),
    connectedIds: new Set(["oracle-1"]),
    activeConnectionId: "oracle-1",
    connections: [],
    treeNodes: [],
    selectedTreeNodeId: null,
  }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
  }),
}));

const emptyResult: QueryResult = { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, messages: [] };

async function setup(connectionId = "oracle-1", database = "ORCL") {
  const { useQueryStore } = await import("../queryStore");
  const store = useQueryStore();
  const tabId = store.openConsoleTab({ connectionId, database });
  return { store, tabId: tabId as string };
}

describe("queryStore command console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorSettings.confirmDangerousSqlExecution = false;
    mocks.executeMulti.mockReset();
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle Local", host: "10.0.0.9", db_type: "oracle", database: "ORCL", query_timeout_secs: 30 });
    setActivePinia(createPinia());
    mocks.subscribe.mockResolvedValue(mocks.cleanup);
    mocks.executeMulti.mockImplementation(async () => [{ ...emptyResult }]);
  });

  it("opens a distinct console tab for each request", async () => {
    const { store, tabId } = await setup();
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.mode).toBe("console");
    expect(tab?.title.startsWith("10.0.0.9 - ")).toBe(true);
    const second = store.openConsoleTab({ connectionId: "oracle-1", database: "ORCL" });
    expect(second).not.toBe(tabId);
    const session = store.consoleSessionFor(tabId);
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0].kind).toBe("notice");
    expect(store.consoleSessionFor(second as string)).not.toBe(session);
    session.input = "SELECT 1;";
    expect(store.consoleSessionFor(second as string).input).toBe("");
    expect(store.consoleSessionFor(tabId).input).toBe("SELECT 1;");
  });

  it("executes a statement and records the terminal echo, output and rerun target", async () => {
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["Message"], rows: [["step 1 done"]], affected_rows: 0, execution_time_ms: 5 }]);
    const { store, tabId } = await setup();
    await store.executeConsoleStatement(tabId, "PROMPT step 1 done");
    const session = store.consoleSessionFor(tabId);
    expect(session.entries.map((entry) => entry.kind)).toEqual(["notice", "command", "output"]);
    expect(session.entries[1].text).toBe("SQL> PROMPT step 1 done");
    expect(session.entries[2].text).toBe("step 1 done");
    expect(session.lastGoodSql).toBe("PROMPT step 1 done");
    expect(session.history).toEqual(["PROMPT step 1 done"]);
    expect(session.isExecuting).toBe(false);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("PROMPT step 1 done");
    // Statements pin to the tab-scoped connection session so `USE`/SET state
    // survives between submissions.
    expect(mocks.executeMulti.mock.calls[0][5]).toMatchObject({ clientSessionId: tabId });
  });

  it("buffers an incomplete statement and completes it with the next line", async () => {
    const { store, tabId } = await setup();
    await store.executeConsoleStatement(tabId, "SELECT 1");
    expect(store.consoleSessionFor(tabId).buffer).toBe("SELECT 1");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    await store.executeConsoleStatement(tabId, "FROM DUAL;");
    const session = store.consoleSessionFor(tabId);
    expect(session.buffer).toBe("");
    expect(session.entries[1].text).toBe("SQL> SELECT 1\n    -> FROM DUAL;");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1\nFROM DUAL;");
  });

  it("`/` re-runs the last successful statement of the console session", async () => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockResolvedValueOnce([{ ...emptyResult }]);
    await store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    mocks.executeMulti.mockClear();
    mocks.executeMulti.mockResolvedValueOnce([{ ...emptyResult }]);
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL;");
    const session = store.consoleSessionFor(tabId);
    expect(session.entries[1].text).toBe("SQL> SELECT 1 FROM DUAL;");
    // Entries: welcome, first echo, output, `/` echo, rerun output.
    expect(session.entries.length).toBe(5);
    expect(session.entries[3].text).toBe("SQL> / → SELECT 1 FROM DUAL;");
    // The `/` itself never joins the history.
    expect(session.history).toEqual(["SELECT 1 FROM DUAL;"]);
  });

  it("reports an error for `/` without a previous statement", async () => {
    const { store, tabId } = await setup();
    await store.executeConsoleStatement(tabId, "/");
    const session = store.consoleSessionFor(tabId);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(session.entries.at(-1)?.kind).toBe("error");
  });

  it("closes the tab on EXIT", async () => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockClear();
    await store.executeConsoleStatement(tabId, "EXIT");
    await vi.waitFor(() => expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined());
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("records backend failures as error entries and keeps the previous rerun target", async () => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockResolvedValueOnce([{ ...emptyResult }]);
    await store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    mocks.executeMulti.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    await store.executeConsoleStatement(tabId, "SELECT missing FROM DUAL;");
    const session = store.consoleSessionFor(tabId);
    expect(session.entries.at(-1)).toMatchObject({ kind: "error", text: "ORA-00942: table or view does not exist" });
    expect(session.lastGoodSql).toBe("SELECT 1 FROM DUAL;");
    mocks.executeMulti.mockClear();
    mocks.executeMulti.mockResolvedValueOnce([{ ...emptyResult }]);
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL;");
  });

  it("navigates history with up/down and restores the drafted input", async () => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockResolvedValue([{ ...emptyResult }]);
    await store.executeConsoleStatement(tabId, "SELECT 1;");
    await store.executeConsoleStatement(tabId, "SELECT 2;");
    expect(store.consoleHistoryNavigate(tabId, -1, "draft")).toEqual({ text: "SELECT 2;", fromHistory: true });
    expect(store.consoleHistoryNavigate(tabId, -1, "SELECT 2;")).toEqual({ text: "SELECT 1;", fromHistory: true });
    expect(store.consoleHistoryNavigate(tabId, 1, "SELECT 1;")).toEqual({ text: "SELECT 2;", fromHistory: true });
    expect(store.consoleHistoryNavigate(tabId, 1, "SELECT 2;")).toEqual({ text: "draft", fromHistory: false });
  });

  it("cancels the running statement through the execution id", async () => {
    mocks.cancelQuery.mockResolvedValue(true);
    const { store, tabId } = await setup();
    let release!: (results: QueryResult[]) => void;
    mocks.executeMulti.mockReturnValueOnce(
      new Promise<QueryResult[]>((resolve) => {
        release = resolve;
      }),
    );
    const run = store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    const session = store.consoleSessionFor(tabId);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledOnce());
    await store.cancelConsoleStatement(tabId);
    expect(mocks.cancelQuery).toHaveBeenCalledWith(session.executionId);
    release([{ ...emptyResult }]);
    await run;
  });

  it.each(["/", "RUN"])("%s reruns only the last successful statement of a batch", async (rerun) => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResult, statement_index: 0 },
      { ...emptyResult, statement_index: 1 },
    ]);
    await store.executeConsoleStatement(tabId, "INSERT INTO t VALUES (1);\nSELECT 1 FROM DUAL;");
    mocks.executeMulti.mockClear();
    await store.executeConsoleStatement(tabId, rerun);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL");
  });

  it("does not remember failed or skipped statements as the rerun target", async () => {
    const { store, tabId } = await setup();
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResult, statement_index: 0 },
      { ...emptyResult, statement_index: 1, execution_error: true },
    ]);
    await store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;\nSELECT missing FROM DUAL;");
    expect(store.consoleSessionFor(tabId).lastGoodSql).toBe("SELECT 1 FROM DUAL");
    mocks.executeMulti.mockResolvedValueOnce([
      { ...emptyResult, statement_index: 0 },
      { ...emptyResult, statement_index: 1 },
    ]);
    await store.executeConsoleStatement(tabId, "SELECT 2 FROM DUAL;\nEXIT\nINSERT INTO t VALUES (1);");
    expect(store.consoleSessionFor(tabId).lastGoodSql).toBe("SELECT 2 FROM DUAL");
  });

  it("holds a PL/SQL block until its slash delimiter and executes it once", async () => {
    const { store, tabId } = await setup();
    for (const line of ["BEGIN", "  NULL;", "END;"]) await store.executeConsoleStatement(tabId, line);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("BEGIN\n  NULL;\nEND;\n/");
  });

  it("preserves explicit MySQL transactions across submissions", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    const { store, tabId } = await setup("mysql-1", "app");
    for (const statement of ["START TRANSACTION;", "INSERT INTO t VALUES (1);", "ROLLBACK;"]) await store.executeConsoleStatement(tabId, statement);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(3);
    for (const call of mocks.executeMulti.mock.calls) expect(call[5]).toMatchObject({ clientSessionId: tabId, preserveExplicitTransaction: true, timeoutSecs: 30 });
  });

  it("handles MySQL EXIT locally instead of sending it to the server", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    const { store, tabId } = await setup("mysql-1", "app");
    await store.executeConsoleStatement(tabId, "exit");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === tabId)).toBeUndefined();
  });

  it("ignores an old target's response without clearing a newer execution", async () => {
    const { store, tabId } = await setup();
    let resolveOld!: (results: QueryResult[]) => void;
    let resolveNew!: (results: QueryResult[]) => void;
    mocks.executeMulti.mockReturnValueOnce(
      new Promise<QueryResult[]>((resolve) => {
        resolveOld = resolve;
      }),
    );
    const oldRun = store.executeConsoleStatement(tabId, "UPDATE t SET n = n + 1;");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledOnce());
    const oldSession = store.consoleSessionFor(tabId);
    const oldExecutionId = oldSession.executionId;
    store.updateDatabase(tabId, "OTHER");
    expect(mocks.cancelQuery).toHaveBeenCalledWith(oldExecutionId);
    mocks.executeMulti.mockReturnValueOnce(
      new Promise<QueryResult[]>((resolve) => {
        resolveNew = resolve;
      }),
    );
    const newRun = store.executeConsoleStatement(tabId, "SELECT 2 FROM DUAL;");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    const newSession = store.consoleSessionFor(tabId);
    expect(newSession).not.toBe(oldSession);
    resolveOld([{ ...emptyResult }]);
    await oldRun;
    expect(newSession.isExecuting).toBe(true);
    expect(newSession.lastGoodSql).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === tabId)?.executionId).toBe(newSession.executionId);
    resolveNew([{ ...emptyResult }]);
    await newRun;
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti.mock.calls.at(-1)?.slice(0, 3)).toEqual(["oracle-1", "OTHER", "SELECT 2 FROM DUAL;"]);
  });

  it("exposes its busy state to generic cancellation and does not remember cancelled SQL", async () => {
    const { store, tabId } = await setup();
    await store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    let resolve!: (results: QueryResult[]) => void;
    mocks.executeMulti.mockReturnValueOnce(
      new Promise<QueryResult[]>((done) => {
        resolve = done;
      }),
    );
    const run = store.executeConsoleStatement(tabId, "UPDATE t SET n = n + 1;");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    const tab = store.tabs.find((tab) => tab.id === tabId)!;
    expect(tab.isExecuting).toBe(true);
    expect(tab.executionId).toBe(store.consoleSessionFor(tabId).executionId);
    expect(await store.cancelTabExecution(tabId)).toBe(true);
    resolve([{ ...emptyResult }]);
    await run;
    expect(tab.isExecuting).toBe(false);
    expect(tab.executionId).toBeUndefined();
    expect(store.consoleSessionFor(tabId).lastGoodSql).toBe("SELECT 1 FROM DUAL;");
  });

  it("cancels a running console query when its tab closes", async () => {
    const { store, tabId } = await setup();
    let resolve!: (results: QueryResult[]) => void;
    mocks.executeMulti.mockReturnValueOnce(
      new Promise<QueryResult[]>((done) => {
        resolve = done;
      }),
    );
    const run = store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledOnce());
    const executionId = store.consoleSessionFor(tabId).executionId;
    store.closeTab(tabId, { force: true });
    expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);
    resolve([{ ...emptyResult }]);
    await run;
    expect(store.tabs.find((tab) => tab.id === tabId)).toBeUndefined();
  });

  it("runs DM8 client commands on Enter and replays only the last statement", async () => {
    mocks.getConfig.mockReturnValue({ id: "dm-1", name: "DM8", db_type: "dameng", database: "", query_timeout_secs: 30 });
    const { store, tabId } = await setup("dm-1", "");
    for (const command of ["DESC t", "EXEC p(1)", "SHOW USER", "PROMPT dm8", "SET TIMING ON"]) {
      await store.executeConsoleStatement(tabId, command);
      expect(mocks.executeMulti.mock.calls.at(-1)?.[2]).toBe(command);
    }
    await store.executeConsoleStatement(tabId, "EXEC p(2)");
    await store.executeConsoleStatement(tabId, "RUN");
    expect(mocks.executeMulti.mock.calls.at(-1)?.[2]).toBe("EXEC p(2)");
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti.mock.calls.at(-1)?.[2]).toBe("EXEC p(2)");
    mocks.executeMulti.mockClear();
    await store.executeConsoleStatement(tabId, "SET SCHEMA DBX_TEST");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    await store.executeConsoleStatement(tabId, ";");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SET SCHEMA DBX_TEST\n;");
    await store.executeConsoleStatement(tabId, "EXIT");
    expect(store.tabs.find((tab) => tab.id === tabId)).toBeUndefined();
  });

  it.each([{ is_production: true }, { production_databases: ["app"] }, { production_databases: ["prod"] }])("requires production approval with %j even if danger confirmation is disabled", async (markers) => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", ...markers });
    const { store, tabId } = await setup("mysql-1", "app");
    const sql = "DELETE FROM users WHERE id = 1;";
    const run = store.executeConsoleStatement(tabId, sql);
    const production = useProductionSafetyStore();
    await vi.waitFor(() => expect(production.pending).toMatchObject({ sql, connectionName: "MySQL", database: "app" }));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(store.consoleSessionFor(tabId).history).toEqual([]);
    production.confirm();
    await run;
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0][2]).toBe(sql);
  });

  it("declines production SQL with a notice and without changing history or rerun target", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", is_production: true });
    const { store, tabId } = await setup();
    await store.executeConsoleStatement(tabId, "SELECT 1 FROM DUAL;");
    mocks.executeMulti.mockClear();
    const run = store.executeConsoleStatement(tabId, "DELETE FROM users;");
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeDefined());
    useProductionSafetyStore().cancel();
    await run;
    const session = store.consoleSessionFor(tabId);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(session.entries.at(-2)?.text).toContain("DELETE FROM users");
    expect(session.entries.at(-1)?.kind).toBe("notice");
    expect(session.history).toEqual(["SELECT 1 FROM DUAL;"]);
    expect(session.lastGoodSql).toBe("SELECT 1 FROM DUAL;");
    expect(session.isExecuting).toBe(false);
    await store.executeConsoleStatement(tabId, "/");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("SELECT 1 FROM DUAL;");
  });

  it.each(["/", "RUN"])("rechecks expanded %s SQL without reusing an earlier approval", async (rerun) => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", is_production: true });
    const { store, tabId } = await setup();
    const sql = "EXEC dangerous_procedure(1)";
    const first = store.executeConsoleStatement(tabId, sql);
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe(sql));
    useProductionSafetyStore().confirm();
    await first;
    mocks.executeMulti.mockClear();
    const run = store.executeConsoleStatement(tabId, rerun);
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe(sql));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    useProductionSafetyStore().cancel();
    await run;
    expect(store.consoleSessionFor(tabId).lastGoodSql).toBe(sql);
    expect(store.consoleSessionFor(tabId).history).toEqual([sql]);
  });

  it("requires readonly unlock before production review, and denial dispatches nothing", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", read_only: true, is_production: true });
    const { store, tabId } = await setup();
    const run = store.executeConsoleStatement(tabId, "EXEC mutate(1)");
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending?.connectionId).toBe("oracle-1"));
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    useReadOnlyUnlockStore().cancel();
    await run;
    expect(store.consoleSessionFor(tabId).history).toEqual([]);
    expect(store.consoleSessionFor(tabId).entries.at(-1)?.kind).toBe("notice");
  });

  it("requires production review after readonly unlock and does not double-prompt for danger", async () => {
    mocks.editorSettings.confirmDangerousSqlExecution = true;
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", read_only: true, is_production: true });
    const { store, tabId } = await setup();
    const run = store.executeConsoleStatement(tabId, "DELETE FROM users;");
    await vi.waitFor(() => expect(useReadOnlyUnlockStore().pending).toBeDefined());
    expect(useProductionSafetyStore().pending).toBeUndefined();
    await useReadOnlyUnlockStore().confirm(60);
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeDefined());
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    useProductionSafetyStore().confirm();
    await run;
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(useSqlExecutionDangerStore().pending).toBeUndefined();
  });

  it.each([true, false])("uses the shared danger dialog outside production (confirm=%s)", async (confirmed) => {
    mocks.editorSettings.confirmDangerousSqlExecution = true;
    const { store, tabId } = await setup();
    const run = store.executeConsoleStatement(tabId, "DELETE FROM users;");
    const danger = useSqlExecutionDangerStore();
    await vi.waitFor(() => expect(danger.pending).toMatchObject({ sql: "DELETE FROM users;", kind: "sql", databaseType: "oracle" }));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    if (confirmed) danger.confirm();
    else danger.cancel();
    await run;
    expect(mocks.executeMulti).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(store.consoleSessionFor(tabId).history).toEqual(confirmed ? ["DELETE FROM users;"] : []);
  });

  it("does not let read-client prefixes or quoted PROMPT text hide later production writes", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", is_production: true });
    const { store, tabId } = await setup();
    const sql = "PROMPT literal ' ;\nDESC emp\nDELETE FROM users;";
    const run = store.executeConsoleStatement(tabId, sql);
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe(sql));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    useProductionSafetyStore().cancel();
    await run;
  });

  it("keeps client-only metadata/text commands and SELECT available without write prompts", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", read_only: true, is_production: true });
    const { store, tabId } = await setup();
    for (const sql of ["DESC emp", "PROMPT literal ' ;", "SELECT 1 FROM DUAL;"]) await store.executeConsoleStatement(tabId, sql);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(3);
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(useReadOnlyUnlockStore().pending).toBeUndefined();
  });

  it("cancels only the closed console's production review and leaves another console's request", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", is_production: true });
    const { store, tabId } = await setup();
    const secondId = store.openConsoleTab({ connectionId: "oracle-1", database: "ORCL" })!;
    const first = store.executeConsoleStatement(tabId, "DELETE FROM a;");
    const second = store.executeConsoleStatement(secondId, "DELETE FROM b;");
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe("DELETE FROM a;"));
    store.closeTab(tabId, { force: true });
    await first;
    await vi.waitFor(() => expect(useProductionSafetyStore().pending?.sql).toBe("DELETE FROM b;"));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    useProductionSafetyStore().confirm();
    await second;
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("DELETE FROM b;");
  });

  it("does not dispatch an approved SQL after its database changes during review", async () => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", name: "Oracle", db_type: "oracle", is_production: true });
    const { store, tabId } = await setup();
    const run = store.executeConsoleStatement(tabId, "DELETE FROM users;");
    await vi.waitFor(() => expect(useProductionSafetyStore().pending).toBeDefined());
    store.updateDatabase(tabId, "OTHER");
    await run;
    expect(useProductionSafetyStore().pending).toBeUndefined();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("Ctrl+C during danger review cancels locally rather than invoking a backend query", async () => {
    mocks.editorSettings.confirmDangerousSqlExecution = true;
    const { store, tabId } = await setup();
    const run = store.executeConsoleStatement(tabId, "DELETE FROM users;");
    await vi.waitFor(() => expect(useSqlExecutionDangerStore().pending).toBeDefined());
    expect(await store.cancelConsoleStatement(tabId)).toBe(true);
    await run;
    expect(useSqlExecutionDangerStore().pending).toBeUndefined();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    expect(store.consoleSessionFor(tabId).lastGoodSql).toBeUndefined();
  });
});
