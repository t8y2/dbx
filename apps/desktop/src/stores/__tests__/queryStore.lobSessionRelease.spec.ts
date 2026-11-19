import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult } from "@/types/database";

const api = vi.hoisted(() => ({
  executeMulti: vi.fn(),
  closeQuerySession: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  cancelQuery: vi.fn(),
  disconnectDb: vi.fn(),
  releaseLargeValue: vi.fn(),
  executeInManualTransaction: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  ...api,
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  analyzeEditableQueryEditability: vi.fn().mockResolvedValue({ editable: false, reason: "complex-query" }),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({ sqlToExecute: options.sql, pageSql: options.sql, pageLimit: options.pagination.limit, pageOffset: options.pagination.offset, useAgentResultSession: true })),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveConnections: vi.fn().mockResolvedValue(undefined),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
}));

function result(session: string): QueryResult {
  return { columns: ["PAYLOAD"], rows: [["LOB preview"]], affected_rows: 0, execution_time_ms: 1, session_id: session, has_more: true };
}

describe("query Store LOB session release through public close and disconnect", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    api.closeQuerySession.mockResolvedValue(undefined);
    api.closeClientConnectionSession.mockResolvedValue(undefined);
    api.cancelQuery.mockResolvedValue(true);
    api.disconnectDb.mockResolvedValue(undefined);
    api.releaseLargeValue.mockResolvedValue(true);
  });

  it("opts JDBC grid queries into deferred values and binds their original client session", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    const connections = useConnectionStore();
    connections.connections = [{ id: "jdbc-lob", name: "JDBC", db_type: "jdbc", database: "APP", read_only: false, connection_string: "jdbc:oracle:thin:@fixture", jdbc_driver_class: "oracle.jdbc.OracleDriver" } as ConnectionConfig];
    connections.connectedIds.add("jdbc-lob");
    const store = useQueryStore();
    const id = store.createTab("jdbc-lob", "APP", "LOB", "query", "APP");
    store.tabs.find((tab) => tab.id === id)!.autoCommit = true;
    api.executeMulti.mockResolvedValueOnce([{ ...result("jdbc-page"), large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 67108864, value_ref: "jdbc-original" }] }]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM FIXTURE");
    const options = api.executeMulti.mock.calls[0][5];
    expect(options.deferLobs).toBe(true);
    expect(options.tableDataPreview).not.toBe(true);
    expect(store.tabs.find((tab) => tab.id === id)?.result?.large_value_context).toEqual(expect.objectContaining({ connectionId: "jdbc-lob", database: "APP", clientSessionId: options.clientSessionId }));
    await store.flushPendingPersist();
  });

  it("keeps SQL marker parsing enabled for JDBC manual table data with mixed LOB types", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    const connections = useConnectionStore();
    connections.connections = [{ id: "jdbc-mixed", name: "JDBC", db_type: "jdbc", database: "APP", read_only: false, connection_string: "jdbc:oracle:thin:@fixture", jdbc_driver_class: "oracle.jdbc.OracleDriver" } as ConnectionConfig];
    connections.connectedIds.add("jdbc-mixed");
    const store = useQueryStore();
    const id = store.createTab("jdbc-mixed", "APP", "FIXTURE", "data", "APP");
    const tab = store.tabs.find((entry) => entry.id === id)!;
    store.setTableMeta(id, { tableName: "FIXTURE", schema: "APP", primaryKeys: ["ID"], columns: ["NUMBER", "NCLOB", "CLOB"].map((data_type, index) => ({ name: ["ID", "N", "C"][index]!, data_type, is_nullable: false, column_default: null, is_primary_key: index === 0, extra: null })) });
    tab.autoCommit = false;
    tab.txnSessionId = "mixed-transaction";
    api.executeInManualTransaction.mockResolvedValueOnce([{ columns: ["ID", "N", "C"], rows: [[1, "national preview", "clob preview"]], affected_rows: 0, execution_time_ms: 1 }]);
    await store.executeTabSql(id, "SELECT ID,N,marker,C FROM FIXTURE");
    const args = api.executeInManualTransaction.mock.calls[0];
    expect(args[0]).toBe("mixed-transaction");
    expect(args[5]).toBe(true);
    expect(args[12]).toBe(true);
    await store.flushPendingPersist();
  });

  it("releases a late manual result using its executed transaction, not the tab's replacement", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    const connections = useConnectionStore();
    connections.connections = [{ id: "txn-lob", name: "OB", db_type: "oceanbase-oracle", database: "SYS", read_only: false } as ConnectionConfig];
    connections.connectedIds.add("txn-lob");
    const store = useQueryStore();
    const id = store.createTab("txn-lob", "SYS", "LOB", "query", "APP");
    const tab = store.tabs.find((tab) => tab.id === id)!;
    tab.autoCommit = false;
    tab.txnSessionId = "executed-transaction";
    let finish!: (results: QueryResult[]) => void;
    api.executeInManualTransaction.mockImplementationOnce(
      () =>
        new Promise<QueryResult[]>((resolve) => {
          finish = resolve;
        }),
    );
    const executing = store.executeTabSql(id, "SELECT PAYLOAD FROM FIXTURE");
    await vi.waitFor(() => expect(api.executeInManualTransaction).toHaveBeenCalledTimes(1));
    expect(api.executeInManualTransaction.mock.calls[0][0]).toBe("executed-transaction");
    tab.txnSessionId = "replacement-transaction";
    tab.executionId = "replacement-execution";
    finish([{ ...result("late-cursor"), large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 67108864, value_ref: "old-reference" }] }]);
    await executing;
    await vi.waitFor(() => expect(api.releaseLargeValue).toHaveBeenCalledWith(expect.objectContaining({ valueRef: "old-reference", txnSessionId: "executed-transaction" })));
    expect(api.releaseLargeValue.mock.calls.every(([request]) => request.txnSessionId !== "replacement-transaction")).toBe(true);
    await store.flushPendingPersist();
  });

  it("preserves locator ownership from hydrated earlier pages when appending", async () => {
    const { appendQueryResultSegment } = await import("@/stores/queryStore");
    const context = { connectionId: "ob-page", database: "SYS", clientSessionId: "original-session" };
    const previous = { ...result("session"), large_value_context: context, large_value_refs: ["hydrated-old"], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 5000, value_ref: "old-preview" }] };
    const segment = { ...result("session"), large_value_refs: ["new"] };
    const combined = appendQueryResultSegment(previous, segment, 100);
    expect(combined.large_value_refs).toEqual(expect.arrayContaining(["hydrated-old", "old-preview", "new"]));
    expect(combined.large_value_context).toEqual(context);
  });

  it.each([false, true, "toggled"] as const)("releases discarded refs but retains captured results (capture=%s)", async (capture) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const connections = useConnectionStore();
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    connections.connections = [{ id: "ob-refresh", name: "OB", db_type: "oceanbase-oracle", database: "SYS", read_only: false } as ConnectionConfig];
    connections.connectedIds.add("ob-refresh");
    const store = useQueryStore();
    const id = store.createTab("ob-refresh", "SYS", "LOB", "query", "APP");
    const context = { connectionId: "ob-refresh", database: "SYS", clientSessionId: "old-client" };
    api.executeMulti.mockResolvedValueOnce([{ ...result("old"), large_value_context: context, large_value_refs: ["old-ref"] }]).mockResolvedValueOnce([result("new")]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    const tab = store.tabs.find((entry) => entry.id === id)!;
    if (capture === "toggled") {
      expect(store.toggleResultAutoSave(id)).toBe(true);
      expect(store.toggleResultAutoSave(id)).toBe(false);
      expect(tab.activeResultRunId).toBeTruthy();
    } else tab.resultAutoSave = capture;
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    if (capture === true) expect(api.releaseLargeValue).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(api.releaseLargeValue).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "ob-refresh", database: "SYS", valueRef: "old-ref" })));
    await store.flushPendingPersist();
  });

  it.each(["failed-append", "shared-result", "history"] as const)("retains old locators still used after an autosave toggle (%s)", async (scenario) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const connections = useConnectionStore();
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    connections.connections = [{ id: "ob-retain", name: "OB", db_type: "oceanbase-oracle", database: "SYS", read_only: false } as ConnectionConfig];
    connections.connectedIds.add("ob-retain");
    const store = useQueryStore();
    const id = store.createTab("ob-retain", "SYS", "LOB", "query", "APP");
    const old = { ...result("old"), large_value_context: { connectionId: "ob-retain", database: "SYS", clientSessionId: "old-client" }, large_value_refs: ["old-ref"] };
    api.executeMulti.mockResolvedValueOnce([old]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    store.toggleResultAutoSave(id);
    store.toggleResultAutoSave(id);
    const tab = store.tabs.find((entry) => entry.id === id)!;
    if (scenario === "history") tab.resultRuns!.push({ ...tab.resultRuns![0], id: "other-retained-run" });
    if (scenario === "failed-append") api.executeMulti.mockRejectedValueOnce(new Error("query failed"));
    else api.executeMulti.mockResolvedValueOnce([scenario === "shared-result" ? { ...old, rows: [["new preview"]] } : result("new")]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE", scenario === "failed-append" ? { appendResult: true } : undefined);
    await store.flushPendingPersist();
    expect(api.releaseLargeValue).not.toHaveBeenCalled();
    if (scenario === "failed-append") expect(tab.result?.large_value_refs).toContain("old-ref");
    else expect(tab.result?.rows).toEqual(scenario === "shared-result" ? [["new preview"]] : [["LOB preview"]]);
  });

  it.each(["closeTab", "disconnect"] as const)("%s closes the original result and client sessions without touching another connection", async (action) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const connections = useConnectionStore();
    const settings = useSettingsStore();
    settings.editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";
    settings.editorSettings.autoCalculateTotalRows = false;
    connections.connections = ["ob-a", "ob-b"].map((id) => ({ id, name: id, db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "fixture", password: "", database: "SYS", read_only: false }) as ConnectionConfig);
    connections.connectedIds.add("ob-a");
    connections.connectedIds.add("ob-b");
    const store = useQueryStore();
    const id = store.createTab("ob-a", "SYS", "LOB", "query", "APP");
    const otherId = store.createTab("ob-b", "SYS", "Other", "query", "APP");
    api.executeMulti.mockResolvedValueOnce([result("result-a")]).mockResolvedValueOnce([result("result-b")]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    await store.executeTabSql(otherId, "SELECT PAYLOAD FROM LOB_FIXTURE");
    const originalSession = api.executeMulti.mock.calls[0][5].clientSessionId;
    const otherSession = api.executeMulti.mock.calls[1][5].clientSessionId;
    expect(originalSession).toEqual(expect.any(String));
    expect(originalSession).not.toBe(otherSession);
    expect(store.tabs.find((tab) => tab.id === id)?.result?.rows).toEqual([["LOB preview"]]);
    if (action === "closeTab") store.closeTab(id, { force: true });
    else await connections.disconnect("ob-a");
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledWith("ob-a", "SYS", originalSession));
    expect(api.closeQuerySession).toHaveBeenCalledWith("ob-a", "SYS", "result-a", originalSession);
    expect(api.closeClientConnectionSession.mock.calls.every((call) => call[0] === "ob-a")).toBe(true);
    expect(api.closeQuerySession.mock.calls.every((call) => call[0] === "ob-a")).toBe(true);
    expect(store.tabs.find((tab) => tab.id === id)?.result).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === otherId)?.result?.rows).toEqual([["LOB preview"]]);
    if (action === "disconnect") {
      expect(api.disconnectDb).toHaveBeenCalledWith("ob-a", undefined);
      expect(connections.connectedIds.has("ob-a")).toBe(false);
      expect(connections.connectedIds.has("ob-b")).toBe(true);
      expect(store.tabs.some((tab) => tab.id === id)).toBe(true);
    }
    await store.flushPendingPersist();
  });

  it.each(["closeTab", "disconnect"] as const)("%s cannot be undone by a late query result", async (action) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const connections = useConnectionStore();
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    connections.connections = [{ id: "ob-late", name: "OB", db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "fixture", password: "", database: "SYS", read_only: false } as ConnectionConfig];
    connections.connectedIds.add("ob-late");
    const store = useQueryStore();
    const id = store.createTab("ob-late", "SYS", "Pending LOB", "query", "APP");
    let finish!: (results: QueryResult[]) => void;
    api.executeMulti.mockImplementationOnce(
      () =>
        new Promise<QueryResult[]>((resolve) => {
          finish = resolve;
        }),
    );
    const executing = store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    await vi.waitFor(() => expect(api.executeMulti).toHaveBeenCalledTimes(1));
    const originalSession = api.executeMulti.mock.calls[0][5].clientSessionId;
    if (action === "closeTab") store.closeTab(id, { force: true });
    else await connections.disconnect("ob-late");
    await vi.waitFor(() => expect(api.closeClientConnectionSession).toHaveBeenCalledWith("ob-late", "SYS", originalSession));
    finish([result("late-result")]);
    await executing;
    expect(store.tabs.find((tab) => tab.id === id)?.result).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === id)?.resultSessionId).toBeUndefined();
    expect(store.tabs.find((tab) => tab.id === id)?.isExecuting ?? false).toBe(false);
    expect(api.cancelQuery).toHaveBeenCalled();
    if (action === "closeTab") expect(store.tabs.some((tab) => tab.id === id)).toBe(false);
    else expect(connections.connectedIds.has("ob-late")).toBe(false);
    await store.flushPendingPersist();
  });

  it("releases replaced refs from the previous result when an execution fails", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const connections = useConnectionStore();
    useSettingsStore().editorSettings.autoCalculateTotalRows = false;
    connections.connections = [{ id: "ob-fail", name: "OB", db_type: "oceanbase-oracle", database: "SYS", read_only: false } as ConnectionConfig];
    connections.connectedIds.add("ob-fail");
    const store = useQueryStore();
    const id = store.createTab("ob-fail", "SYS", "LOB", "query", "APP");
    api.executeMulti.mockResolvedValueOnce([{ ...result("old"), large_value_context: { connectionId: "ob-fail", database: "SYS", clientSessionId: "old-client" }, large_value_refs: ["old-ref"] }]);
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    expect(store.tabs.find((entry) => entry.id === id)?.result?.large_value_refs).toContain("old-ref");
    api.executeMulti.mockRejectedValueOnce(new Error("query failed"));
    await store.executeTabSql(id, "SELECT PAYLOAD FROM LOB_FIXTURE");
    const tab = store.tabs.find((entry) => entry.id === id)!;
    expect(tab.result?.execution_error).toBe(true);
    await vi.waitFor(() => expect(api.releaseLargeValue).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "ob-fail", database: "SYS", valueRef: "old-ref" })));
    await store.flushPendingPersist();
  });
});
