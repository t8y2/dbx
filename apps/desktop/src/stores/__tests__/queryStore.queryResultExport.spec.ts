import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
  executeMulti: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  buildTableSelectSql: vi.fn(),
  buildDataGridContextFilterCondition: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  exportSettings: { exportRowLimitEnabled: false, exportRowLimit: 100 },
}));

vi.mock("@/lib/backend/api", () => ({
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  executeMulti: mocks.executeMulti,
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  buildTableSelectSql: mocks.buildTableSelectSql,
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  prepareQueryPaginationExecutionPlan: mocks.prepareQueryPaginationExecutionPlan,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
    connectionIdentifierQuote: mocks.connectionIdentifierQuote,
    lookupLocalCompletionTables: () => [],
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      exportBatchSize: 1000,
      ...mocks.exportSettings,
      globalQueryTimeoutSecs: 30,
      queryExportKeysetOptimizationEnabled: true,
      numericColumnRightAlign: true,
    },
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

describe("queryStore query result export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportSettings.exportRowLimitEnabled = false;
    mocks.exportSettings.exportRowLimit = 100;
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.closeClientConnectionSession.mockResolvedValue(undefined);
    mocks.closeQuerySession.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ id: "kingbase-1", name: "Kingbase", db_type: "kingbase", database: "app", query_timeout_secs: 30 });
    mocks.connectionIdentifierQuote.mockReturnValue("[");
  });

  async function legacySheetFixture() {
    const config = { id: "oracle-1", name: "Oracle", db_type: "oracle" as const, database: "XE" };
    mocks.getConfig.mockReturnValue(config);
    mocks.getColumns.mockResolvedValue([
      { name: "ID", data_type: "NUMBER", is_primary_key: true },
      { name: "BODY", data_type: "CLOB" },
    ]);
    mocks.listIndexes.mockResolvedValue([{ name: "PK_ITEMS", columns: ["ID"], is_primary: true, is_unique: true }]);
    mocks.buildDataGridContextFilterCondition.mockImplementation(async ({ columnName, value }) => `${columnName} = ${value}`);
    mocks.buildTableSelectSql.mockResolvedValue("SELECT ID, BODY FROM HR.ITEMS WHERE ID = 7");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "XE", "Query");
    const result: QueryResult = {
      columns: ["KEY_ALIAS", "BODY_ALIAS"],
      rows: [[7, "preview"]],
      affected_rows: 0,
      execution_time_ms: 0,
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 100 }],
      legacy_export_source: { connectionId: "oracle-1", database: "XE", schema: "HR", databaseType: "oracle", connectionFingerprint: connectionConfigFingerprint(config), statementSql: "SELECT i.ID AS KEY_ALIAS, i.BODY AS BODY_ALIAS FROM HR.ITEMS i", ordinaryReadSafe: true },
    };
    return { store, id, result };
  }

  it("resolves a non-active sheet from its captured table and aliases without replaying the query", async () => {
    const { store, id, result } = await legacySheetFixture();
    const capture = store.captureResultLegacyValuesForExport(id, result);
    expect(capture.unavailableReason).toBeUndefined();
    expect(mocks.getColumns).not.toHaveBeenCalled();
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.database = "OTHER";
    tab.sql = "CALL other_procedure()";
    result.rows[0]![0] = 99;
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["ID", "BODY"], rows: [[7, "complete"]], affected_rows: 0, execution_time_ms: 0 }]);
    const values = await capture.read!(new AbortController().signal);
    expect(values.get(0)?.get(1)).toBe("complete");
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ schema: "HR", tableName: "ITEMS", columns: ["ID", "BODY"], whereInput: "((ID = 7))" }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("oracle-1", "XE", "SELECT ID, BODY FROM HR.ITEMS WHERE ID = 7", undefined, expect.any(String), expect.any(Object));
    expect(result.rows).toEqual([[99, "preview"]]);
  });

  it.each(["missing", "procedure", "expression", "setup"])("does not infer missing or unsafe legacy sheet provenance (%s)", async (kind) => {
    const { store, id, result } = await legacySheetFixture();
    if (kind === "missing") delete result.legacy_export_source;
    if (kind === "procedure") result.legacy_export_source!.statementSql = "CALL fill_items()";
    if (kind === "expression") result.legacy_export_source!.statementSql = "SELECT ID, BODY || 'suffix' AS BODY_ALIAS FROM HR.ITEMS";
    if (kind === "setup") result.legacy_export_source!.ordinaryReadSafe = false;
    const capture = store.captureResultLegacyValuesForExport(id, result);
    if (capture.read) await expect(capture.read(new AbortController().signal)).rejects.toMatchObject({ status: "failed" });
    else expect(capture.unavailableReason).toBeTruthy();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("does not borrow the active grid row identifier for a different sheet", async () => {
    const { store, id, result } = await legacySheetFixture();
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.tableMeta = { tableName: "OTHER", schema: "HR", primaryKeys: ["BODY"], columns: [{ name: "BODY", data_type: "VARCHAR" }] };
    mocks.getColumns.mockResolvedValueOnce([
      { name: "ID", data_type: "NUMBER" },
      { name: "BODY", data_type: "CLOB" },
    ]);
    mocks.listIndexes.mockResolvedValueOnce([]);
    await expect(store.captureResultLegacyValuesForExport(id, result).read!(new AbortController().signal)).rejects.toMatchObject({ status: "failed" });
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(tab.tableMeta.tableName).toBe("OTHER");
  });

  it.each(["success", "transport"])("waits for the actual metadata reply after cancellation (%s)", async (outcome) => {
    const { store, id, result } = await legacySheetFixture();
    let resolve!: (value: unknown[]) => void;
    let reject!: (error: Error) => void;
    mocks.getColumns.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const controller = new AbortController();
    const pending = store.captureResultLegacyValuesForExport(id, result).read!(controller.signal).catch((error) => error);
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalledOnce());
    controller.abort();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.listIndexes).not.toHaveBeenCalled();
    if (outcome === "transport") reject(new Error("metadata reply lost"));
    else resolve([]);
    expect(await pending).toMatchObject({ status: outcome === "transport" ? "unknown" : "cancelled" });
    expect(mocks.listIndexes).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("captures SQL, location and export settings before a queued request starts", async () => {
    mocks.exportSettings.exportRowLimitEnabled = true;
    mocks.exportSettings.exportRowLimit = 100;
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "original", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM original_items";
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 0 };
    const build = store.captureQueryResultExportRequest(id, true)!;
    tab.lastExecutedSql = "SELECT secret FROM other_items";
    tab.database = "other";
    mocks.exportSettings.exportRowLimit = 9;
    store.tabs.splice(store.tabs.indexOf(tab), 1);

    const request = await build({ exportId: "queued", filePath: "original.csv", format: "csv" });
    expect(request).toEqual(expect.objectContaining({ connectionId: "kingbase-1", database: "original", sql: "SELECT id FROM original_items", rowLimit: 100 }));
  });

  it("rejects a queued request when the connection identity changes during reconnect", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 0 };
    const build = store.captureQueryResultExportRequest(id, true)!;
    mocks.ensureConnected.mockImplementationOnce(async () => {
      mocks.getConfig.mockReturnValue({ id: "kingbase-1", name: "Kingbase", db_type: "kingbase", host: "different-target" });
    });
    await expect(build({ exportId: "queued", filePath: "original.csv", format: "csv" })).rejects.toThrow((await import("@/i18n")).default.global.t("exportProgress.connectionChanged"));
  });

  it("captures fallback pagination and waits for its independent session to close", async () => {
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({ sqlToExecute: request.sql, pageLimit: 2, pageOffset: 0, useAgentResultSession: false }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 0 }]);
    let close!: () => void;
    mocks.closeClientConnectionSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "original", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM original_items";
    tab.result = { columns: ["id"], rows: [[0]], has_more: true, execution_time_ms: 0, affected_rows: 0 };
    const fetch = store.captureTabResultForExport(id)!;
    tab.lastExecutedSql = "SELECT secret FROM other_items";
    tab.database = "other";
    let settled = false;
    const result = fetch().then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(mocks.executeMulti).toHaveBeenCalledWith("kingbase-1", "original", "SELECT id FROM original_items", undefined, expect.any(String), expect.objectContaining({ clientSessionId: expect.stringContaining(`${id}:export:`) }));
    close();
    expect((await result)?.rows).toEqual([[1]]);
  });

  it.each(["success", "transport", "cursor_cleanup"] as const)("keeps captured export cancellation behind the actual read and cleanup (%s)", async (completion) => {
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT id FROM items", pageLimit: 1, pageOffset: 0, useAgentResultSession: true });
    let resolveRead!: (value: unknown) => void;
    let rejectRead!: (error: Error) => void;
    mocks.executeMulti.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
    );
    if (completion === "cursor_cleanup") mocks.closeQuerySession.mockRejectedValueOnce(new Error("cursor close lost"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[0]], has_more: true, execution_time_ms: 0, affected_rows: 0 };
    const controller = new AbortController();
    const pending = store.captureTabResultForExport(id)!(undefined, { signal: controller.signal }).catch((error) => error);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledOnce());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    if (completion === "transport") rejectRead(new Error("read transport lost"));
    else resolveRead([{ columns: ["id"], rows: [[1]], has_more: true, session_id: "owned-cursor", execution_time_ms: 0, affected_rows: 0 }]);
    expect(await pending).toMatchObject({ status: completion === "success" ? "cancelled" : "unknown" });
    expect(mocks.executeMulti).toHaveBeenCalledOnce();
    expect(mocks.executeMulti.mock.calls[0]![5]).toMatchObject({ deferLobs: false });
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledOnce();
    if (completion !== "transport") expect(mocks.closeQuerySession).toHaveBeenCalledWith("kingbase-1", "app", "owned-cursor", expect.any(String), undefined);
  });

  it.each(["preview", "unknown_error", "not_started"] as const)("does not return incomplete captured export data (%s)", async (reason) => {
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT id FROM items", pageLimit: 2, pageOffset: 0, useAgentResultSession: false });
    mocks.executeMulti.mockResolvedValueOnce([
      {
        columns: ["id"],
        rows: [["preview"]],
        execution_time_ms: 0,
        affected_rows: 0,
        ...(reason === "preview"
          ? { large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 5000 }] }
          : { execution_error: true, error: { version: 1, code: "DBX-JDBC-4001", messageKey: "backendErrors.jdbc.sqlFailed", messageParams: {}, operationOutcome: reason === "not_started" ? "not_started" : "unknown" } }),
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[0]], has_more: true, execution_time_ms: 0, affected_rows: 0 };
    await expect(store.captureTabResultForExport(id)!()).rejects.toMatchObject({ status: reason === "unknown_error" ? "unknown" : "failed" });
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledOnce();
  });

  it.each(["ending", "lost", "unknown"] as const)("rejects a queued request whose transaction is %s", async (status) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 0 };
    tab.autoCommit = false;
    tab.txnSessionId = "original-transaction";
    const build = store.captureQueryResultExportRequest(id, true)!;
    tab.txnStatus = status;
    await expect(build({ exportId: "queued", filePath: "original.csv", format: "csv" })).rejects.toThrow((await import("@/i18n")).default.global.t("exportProgress.transactionUnavailable"));
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
  });

  it.each([99, 100, 101])("probes a result of %i rows without a cached total", async (count) => {
    mocks.exportSettings.exportRowLimitEnabled = true;
    mocks.getConfig.mockReturnValue({ id: "mysql-1", db_type: "mysql", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({
      sqlToExecute: request.sql,
      pageLimit: request.pagination.limit,
      pageOffset: request.pagination.offset,
      useAgentResultSession: false,
    }));
    mocks.executeMulti.mockImplementation(async (_id, _database, _sql, _schema, _executionId, options) => [
      {
        columns: ["id"],
        rows: Array.from({ length: Math.min(count, options.maxRows) }, (_, index) => [index]),
        execution_time_ms: 0,
        affected_rows: 0,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const { queryResultTransferIncomplete } = await import("@/components/transfer/queryResultTransfer");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.sql = "SELECT id FROM items";
    tab.lastExecutedSql = tab.sql;
    tab.result = { columns: ["id"], column_types: ["bigint unsigned"], rows: [[0]], execution_time_ms: 0, affected_rows: 0 };
    expect(tab.resultTotalRowCount).toBeUndefined();
    const result = await store.fetchTabResultForExport(id, undefined, true);
    expect(result?.rows).toHaveLength(count);
    expect(result?.column_types).toEqual(["bigint unsigned"]);
    expect(queryResultTransferIncomplete(result!, 100)).toBe(count > 100);
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "app", tab.sql, undefined, expect.any(String), expect.objectContaining({ maxRows: 101 }));
    const ordinaryExport = await store.fetchTabResultForExport(id);
    expect(ordinaryExport?.rows).toHaveLength(Math.min(count, 100));
  });

  it("does not treat an earlier page's has_more marker as incomplete", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", db_type: "mysql", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT id FROM items", pageLimit: 1, pageOffset: 0, useAgentResultSession: true });
    mocks.executeMulti.mockImplementation(async (_id, _database, _sql, _schema, _executionId, options) => [
      options.resultSessionId ? { columns: ["id"], rows: [[2]], has_more: false, session_id: "s2", execution_time_ms: 0, affected_rows: 0 } : { columns: ["id"], rows: [[1]], has_more: true, session_id: "s1", execution_time_ms: 0, affected_rows: 0 },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const { queryResultTransferIncomplete } = await import("@/components/transfer/queryResultTransfer");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.sql = "SELECT id FROM items";
    tab.lastExecutedSql = tab.sql;
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 0 };
    const result = await store.fetchTabResultForExport(id, undefined, true);
    expect(result?.rows).toEqual([[1], [2]]);
    expect(queryResultTransferIncomplete(result!)).toBe(false);
  });

  it.each(["SELECT * FROM events", "SELECT t.* FROM events t"])("exports every wildcard page and its real __dbx_row_num column: %s", async (sql) => {
    mocks.getConfig.mockReturnValue({ id: "ob-1", db_type: "oceanbase-oracle", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({
      sqlToExecute: request.sql,
      pageLimit: 2,
      pageOffset: request.pagination.offset,
      useAgentResultSession: true,
    }));
    let row = 0;
    mocks.executeMulti.mockImplementation(async () => [
      {
        columns: ["ID", "__dbx_row_num"],
        column_types: ["NUMBER", "VARCHAR2"],
        rows: Array.from({ length: 2 }, () => [++row, `user-${row}`]),
        has_more: row < 6,
        session_id: "ob-export-cursor",
        execution_time_ms: 0,
        affected_rows: 0,
      },
    ]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("ob-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = sql;
    tab.result = { columns: ["ID", "__dbx_row_num"], rows: [[1, "user-1"]], has_more: true, execution_time_ms: 0, affected_rows: 0 };
    const result = await store.fetchTabResultForExport(id, undefined, true);
    expect(result?.columns).toEqual(["ID", "__dbx_row_num"]);
    expect(result?.rows).toEqual(Array.from({ length: 6 }, (_, index) => [index + 1, `user-${index + 1}`]));
    expect(mocks.executeMulti).toHaveBeenCalledTimes(3);
    for (const [index, call] of mocks.executeMulti.mock.calls.entries()) {
      expect(call[2]).toBe(sql);
      expect(call[5]).toEqual(expect.objectContaining({ pageSize: 2, fetchSize: 2, resultSessionId: index ? "ob-export-cursor" : undefined }));
    }
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("ob-1", "app", "ob-export-cursor", id, undefined);
  });

  it.each(["SELECT * FROM events", "SELECT t.* FROM events t"])("releases the wildcard export cursor when a later fetch fails: %s", async (sql) => {
    mocks.getConfig.mockReturnValue({ id: "ob-1", db_type: "oceanbase-oracle", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: sql, pageLimit: 2, pageOffset: 0, useAgentResultSession: true });
    mocks.executeMulti.mockResolvedValueOnce([
      {
        columns: ["ID", "__dbx_row_num"],
        rows: [
          [1, "user-1"],
          [2, "user-2"],
        ],
        has_more: true,
        session_id: "ob-export-cursor",
        execution_time_ms: 0,
        affected_rows: 0,
      },
    ]);
    mocks.executeMulti.mockRejectedValueOnce(new Error("Query cancelled"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("ob-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = sql;
    tab.result = { columns: ["ID", "__dbx_row_num"], rows: [[1, "user-1"]], has_more: true, execution_time_ms: 0, affected_rows: 0 };
    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow("Query cancelled");
    expect(mocks.executeMulti.mock.calls[1]![5].resultSessionId).toBe("ob-export-cursor");
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("ob-1", "app", "ob-export-cursor", id, undefined);
  });

  it.each(["CALL update_and_list_items()", "INSERT INTO items VALUES (1) RETURNING id", "WITH changed AS (DELETE FROM items RETURNING id) SELECT * FROM changed"])("does not replay a result-producing mutation during transfer: %s", async (sql) => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", db_type: "oracle", database: "app" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = sql;
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 1, has_more: false };

    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual([[1]]);
    expect(mocks.prepareQueryPaginationExecutionPlan).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it.each(["has_more", "unknown_completeness", "truncated", "last_page", "large_value"])("rejects an incomplete cached mutation result (%s) without replaying it", async (reason) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "CALL update_and_list_items()";
    tab.result = { columns: ["id"], rows: [[1]], execution_time_ms: 0, affected_rows: 1, has_more: reason === "has_more", truncated: reason === "truncated" };
    if (reason === "unknown_completeness") tab.result.has_more = undefined;
    if (reason === "last_page") tab.resultPageOffset = 10;
    if (reason === "large_value") tab.result.large_value_cells = [{ row_index: 0, column_index: 0, original_bytes: 10000 }];

    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it.each(["missing_result", "missing_session", "empty_cursor_page", "missing_has_more", "changed_columns", "changed_types", "pagination_error"])("rejects incomplete transfer pagination (%s)", async (reason) => {
    mocks.getConfig.mockReturnValue({ id: "oracle-1", db_type: "oracle", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT id FROM items", pageLimit: 1, pageOffset: 0, useAgentResultSession: true, ...(reason === "pagination_error" ? { paginationError: "Cannot paginate this query" } : {}) });
    const completePage = { columns: ["id"], column_types: ["integer"], rows: [[1]], has_more: false, session_id: "s1", execution_time_ms: 0, affected_rows: 0 };
    if (reason === "changed_columns" || reason === "changed_types") {
      mocks.executeMulti.mockResolvedValueOnce([{ ...completePage, has_more: true }]).mockResolvedValueOnce([{ ...completePage, ...(reason === "changed_columns" ? { columns: ["name"] } : { column_types: ["text"] }) }]);
    } else {
      mocks.executeMulti.mockResolvedValue(reason === "missing_result" ? [] : [{ ...completePage, has_more: reason === "missing_has_more" ? undefined : true, session_id: reason === "missing_session" ? undefined : "s1", rows: reason === "empty_cursor_page" ? [] : [[1]] }]);
    }
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("oracle-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { ...completePage, has_more: true, session_id: undefined };

    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.executeMulti.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("removes only recorded hidden columns when exporting a sorted query", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", db_type: "mysql", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({ sqlToExecute: request.sql, pageLimit: 1000, pageOffset: 0, useAgentResultSession: false }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["name", "__DBX_PK_0"], column_types: ["varchar", "int"], rows: [["Ada", 42]], execution_time_ms: 0, affected_rows: 0 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT name FROM items";
    tab.resultSortedSql = "SELECT name, id AS __DBX_PK_0 FROM items ORDER BY name";
    tab.result = { columns: ["name", "__DBX_PK_0"], column_types: ["varchar", "int"], rows: [["Ada", 42]], hidden_column_indexes: [1], execution_time_ms: 0, affected_rows: 0 };

    const result = await store.fetchTabResultForExport(id, undefined, true);
    expect(result?.columns).toEqual(["name"]);
    expect(result?.column_types).toEqual(["varchar"]);
    expect(result?.rows).toEqual([["Ada"]]);
    expect(tab.result.columns).toEqual(["name", "__DBX_PK_0"]);

    tab.result.hidden_column_indexes = undefined;
    expect((await store.fetchTabResultForExport(id, undefined, true))?.columns).toEqual(["name", "__DBX_PK_0"]);
  });

  it("transfers a complete visible snapshot without re-executing session-local SQL", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT name, id AS __DBX_PK_0 FROM session_temp_items";
    tab.result = { columns: ["name", "__DBX_PK_0"], column_types: ["varchar", "int"], hidden_column_indexes: [1], rows: [["visible value", 42]], has_more: false, execution_time_ms: 0, affected_rows: 0 };

    const result = await store.fetchTabResultForExport(id, undefined, true);
    expect(result?.rows).toEqual([["visible value"]]);
    expect(result?.columns).toEqual(["name"]);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    tab.result.rows[0]![0] = "changed later";
    expect(result?.rows).toEqual([["visible value"]]);
  });

  it.each(["mysql", "postgres", "highgo"])("fetches beyond a full SQL page whose driver reports has_more=false (%s)", async (dbType) => {
    mocks.getConfig.mockReturnValue({ id: "source", db_type: dbType, database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({ sqlToExecute: request.sql, pageLimit: request.pagination.limit, pageOffset: request.pagination.offset, useAgentResultSession: false }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[1], [2], [3]], has_more: false, execution_time_ms: 0, affected_rows: 0 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("source", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1], [2]], has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 2;
    tab.resultPageOffset = 0;

    tab.resultPageSql = "SELECT id FROM items LIMIT 2";

    expect(tab.resultTotalRowCount).toBeUndefined();
    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual([[1], [2], [3]]);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
  });

  it.each(["short_first_page", "short_appended_page", "exhausted_cursor"])("keeps a snapshot whose completeness is proven (%s)", async (reason) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM session_temp_items";
    const rows = reason === "short_first_page" ? [[1]] : reason === "short_appended_page" ? [[1], [2], [3]] : [[1], [2]];
    // JDBC closes an exhausted cursor and returns no session_id, including
    // when its last page happens to be exactly full.
    tab.result = { columns: ["id"], rows, has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 2;
    tab.resultPageOffset = 0;
    tab.resultExecutedPageLimit = 2;
    tab.resultExecutedPageOffset = reason === "short_appended_page" ? 2 : 0;
    if (reason !== "exhausted_cursor") tab.resultPageSql = "SELECT id FROM session_temp_items LIMIT 2";

    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual(rows);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it.each([undefined, 2, 4])("does not use a full SQL page's cached count (%s) as proof of exhaustion", async (cachedTotal) => {
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({ sqlToExecute: request.sql, pageLimit: request.pagination.limit, pageOffset: request.pagination.offset, useAgentResultSession: false }));
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[1], [2], [3], [4], [5]], has_more: false, execution_time_ms: 0, affected_rows: 0 }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1], [2], [3], [4]], has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 2;
    tab.resultPageOffset = 0;
    tab.resultExecutedPageLimit = 2;
    tab.resultExecutedPageOffset = 2;
    tab.resultPageSql = "SELECT id FROM items LIMIT 2";
    // COUNT can run on another session, where a same-named permanent table
    // has fewer rows than the temporary table behind the actual SELECT.
    tab.resultTotalRowCount = cachedTotal;

    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual([[1], [2], [3], [4], [5]]);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
  });

  it("rejects a full cached SQL page if export pagination is unavailable", async () => {
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: "SELECT id FROM items", useAgentResultSession: false });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1]], has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 1;
    tab.resultPageOffset = 0;
    tab.resultPageSql = `SELECT id FROM items LIMIT ${tab.resultPageLimit}`;

    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it.each([false, true])("only transfers a complete manual-transaction snapshot (complete=%s)", async (complete) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.autoCommit = false;
    tab.txnSessionId = "uncommitted-source";
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: [[1]], has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = complete ? 2 : 1;
    tab.resultPageOffset = 0;
    tab.resultPageSql = `SELECT id FROM items LIMIT ${tab.resultPageLimit}`;
    if (complete) tab.resultTotalRowCount = 1;

    if (complete) expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual([[1]]);
    else await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it.each([0, 1])("transfers a manual-transaction snapshot after a %i-row tail without replay", async (tailRows) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.autoCommit = false;
    tab.txnSessionId = "uncommitted-source";
    tab.lastExecutedSql = "SELECT id FROM items";
    tab.result = { columns: ["id"], rows: Array.from({ length: 2 + tailRows }, (_, index) => [index]), has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 2;
    tab.resultPageOffset = 0;
    tab.resultExecutedPageLimit = 2;
    tab.resultExecutedPageOffset = 2;
    tab.resultPageSql = "SELECT id FROM items LIMIT 2";
    tab.resultTotalRowCount = 2;
    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual(tab.result.rows);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    expect(tab.txnSessionId).toBe("uncommitted-source");
  });

  it.each([undefined, "source-result-session"])("keeps the source client session while reading paginated transfer rows (%s)", async (resultClientSessionId) => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", db_type: "mysql", database: "app" });
    mocks.prepareQueryPaginationExecutionPlan.mockImplementation(async (request) => ({ sqlToExecute: request.sql, pageLimit: request.pagination.limit, pageOffset: request.pagination.offset, useAgentResultSession: false }));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM session_temp_items";
    tab.result = { columns: ["id"], rows: [[1]], has_more: false, execution_time_ms: 0, affected_rows: 0 };
    tab.resultPageLimit = 1;
    tab.resultPageOffset = 0;
    tab.resultPageSql = "SELECT id FROM session_temp_items LIMIT 1";
    tab.resultClientSessionId = resultClientSessionId;
    const expectedSession = resultClientSessionId ?? id;
    mocks.executeMulti.mockImplementation(async (_connectionId, _database, _sql, _schema, _executionId, options) => [{ columns: ["id"], rows: options.clientSessionId === expectedSession ? [[1], [2]] : [[99]], has_more: false, execution_time_ms: 0, affected_rows: 0 }]);

    expect((await store.fetchTabResultForExport(id, undefined, true))?.rows).toEqual([[1], [2]]);
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    await store.fetchTabResultForExport(id);
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("mysql-1", "app", `${id}:export`);
  });

  it("leaves the grid's live cursor untouched until its full result is loaded", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT id FROM session_temp_items";
    tab.result = { columns: ["id"], rows: [[1]], has_more: true, session_id: "grid-cursor", execution_time_ms: 0, affected_rows: 0 };
    tab.resultSessionId = "grid-cursor";
    tab.resultPageLimit = 1;
    tab.resultPageOffset = 0;

    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.closeQuerySession).not.toHaveBeenCalled();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    expect(tab.resultSessionId).toBe("grid-cursor");
  });

  it("closes only the newly opened cursor when its first page has a large-value preview", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.lastExecutedSql = "SELECT payload FROM items";
    tab.result = { columns: ["payload"], rows: [["preview"]], has_more: false, large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 10000 }], execution_time_ms: 0, affected_rows: 0 };
    mocks.prepareQueryPaginationExecutionPlan.mockResolvedValue({ sqlToExecute: tab.lastExecutedSql, pageLimit: 1, pageOffset: 0, useAgentResultSession: true });
    mocks.executeMulti.mockResolvedValue([{ ...tab.result, session_id: "new-export-cursor", has_more: true }]);

    await expect(store.fetchTabResultForExport(id, undefined, true)).rejects.toThrow();
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("kingbase-1", "app", "new-export-cursor", id, undefined);
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("passes the live connection identifier quote to backend SQL export", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT select FROM audit_log";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["select"],
      rows: [["value"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-1",
      filePath: "audit.sql",
      format: "sql",
      exportTableName: "audit_log",
      exportColumnTypes: ["text"],
    });

    expect(request?.identifierQuote).toBe("[");
    expect(mocks.connectionIdentifierQuote).toHaveBeenCalledWith("kingbase-1");
  });

  it.each([
    [false, "txn-1", "txn-1"],
    [true, "txn-1", undefined],
    [false, undefined, undefined],
  ])("passes the open manual transaction to the backend export (autoCommit=%s, txn=%s)", async (autoCommit, txnSessionId, expected) => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", db_type: "mysql", database: "app" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.autoCommit = autoCommit;
    tab.txnSessionId = txnSessionId;
    tab.sql = "SELECT id FROM items";
    tab.lastExecutedSql = tab.sql;
    tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };

    const request = await store.buildQueryResultExportRequest(tabId, { exportId: "export-txn", filePath: "items.csv", format: "csv" });

    expect(request?.txnSessionId).toBe(expected);
  });

  it("passes the selected SQL INSERT mode to the backend request", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT id, name FROM users";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["id", "name"],
      rows: [[1, "Ada"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-single",
      filePath: "users.sql",
      format: "sql",
      exportTableName: "users",
      insertMode: "single",
    });

    expect(request?.insertMode).toBe("single");
  });

  it("keeps query execution schema separate from the resolved Oracle INSERT owner", async () => {
    mocks.getConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCLPDB1",
      default_schema: "CURRENT_USER",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCLPDB1", "Query", "query", "CURRENT_USER", "SELECT ID FROM APP_OWNER.USERS");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["ID"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    tab.tableMeta = { schema: "APP_OWNER", tableName: "USERS", columns: [], primaryKeys: ["ID"] };
    tab.queryAnalysis = {
      schema: "APP_OWNER",
      tableName: "USERS",
      selectStar: false,
      sources: [{ key: "USERS:0", schema: "APP_OWNER", tableName: "USERS" }],
      columns: [{ sourceName: "ID", resultName: "ID", expression: "ID" }],
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "oracle-owner-export",
      filePath: "users.sql",
      format: "sql",
      exportTableName: "USERS",
      exportSchema: "APP_OWNER",
    });

    expect(request).toMatchObject({
      databaseType: "oracle",
      database: "ORCLPDB1",
      schema: "CURRENT_USER",
      exportSchema: "APP_OWNER",
      exportTableName: "USERS",
    });
  });

  it("does not use a first source as the INSERT target of a multi-source query", async () => {
    mocks.getConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCLPDB1",
      default_schema: "CURRENT_USER",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCLPDB1", "Query", "query", "CURRENT_USER", "SELECT U.ID FROM APP_OWNER.USERS U JOIN APP_OWNER.ORDERS O ON O.USER_ID = U.ID");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.lastExecutedSql = tab.sql;
    tab.result = { columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    tab.tableMeta = { schema: "APP_OWNER", tableName: "USERS", columns: [], primaryKeys: ["ID"] };
    tab.queryAnalysis = {
      schema: "APP_OWNER",
      tableName: "USERS",
      selectStar: false,
      multiSource: true,
      sources: [
        { key: "USERS:0", schema: "APP_OWNER", tableName: "USERS" },
        { key: "ORDERS:1", schema: "APP_OWNER", tableName: "ORDERS" },
      ],
      columns: [{ sourceName: "ID", resultName: "ID", expression: "U.ID" }],
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "oracle-join-export",
      filePath: "query.sql",
      format: "sql",
      exportTableName: "USERS",
      exportSchema: "APP_OWNER",
    });

    expect(request?.schema).toBe("CURRENT_USER");
    expect(request?.exportTableName).toBeUndefined();
    expect(request?.exportSchema).toBeUndefined();
  });

  it("uses the Agent cursor for SQL Server legacy result export", async () => {
    mocks.getConfig.mockReturnValue({
      id: "sqlserver-2000",
      name: "SQL Server 2000",
      db_type: "sqlserver",
      driver_profile: "sqlserver-legacy",
      database: "master",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-2000", "master", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT * FROM dbo.Users";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-legacy",
      filePath: "users.csv",
      format: "csv",
    });

    expect(request?.useAgentCursor).toBe(true);
  });

  it("strips the MySQL CLI vertical-output suffix from export re-execution SQL", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SHOW CREATE FUNCTION fun_grade \\G";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["Create Function"],
      rows: [["definition"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-g",
      filePath: "fun.csv",
      format: "csv",
    });

    expect(request?.sql).toBe("SHOW CREATE FUNCTION fun_grade");
    expect(request?.queryBaseSql).toBe("SHOW CREATE FUNCTION fun_grade");
  });
});
