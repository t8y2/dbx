import { shallowRef } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MongoExportProgress, MongoExportRequest, MongoExportSummary, TableExportProgress, TableExportRequest } from "@/lib/backend/api";
import type { TreeNode, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ mode: vi.fn(), save: vi.fn(), export: vi.fn(), cancel: vi.fn(), ensure: vi.fn(), toast: vi.fn(), tableExport: vi.fn(), tableCancel: vi.fn(), query: vi.fn(), json: vi.fn(), buildSelect: vi.fn(), closeCursor: vi.fn(), closeClient: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  exportMongodbQuery: mocks.export,
  cancelMongodbExport: mocks.cancel,
  startTableExport: mocks.tableExport,
  cancelTableExport: mocks.tableCancel,
  executeQuery: mocks.query,
  exportQueryResultJson: mocks.json,
  buildTableSelectSql: mocks.buildSelect,
  closeQuerySession: mocks.closeCursor,
  closeClientConnectionSession: mocks.closeClient,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:/exports") }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/export/exportExecutionMode", () => ({ showExportExecutionModeDialog: mocks.mode }));
vi.mock("@/lib/export/exportPath", () => ({ promptExportSavePath: mocks.save, autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));

describe("sidebar Mongo manual export queue", () => {
  const operations: Array<{ request: MongoExportRequest; progress: (value: MongoExportProgress) => void; resolve: (value: MongoExportSummary) => void; reject: (error: Error) => void }> = [];
  const tables: Array<{ request: TableExportRequest; progress: (value: TableExportProgress) => void; resolve: (value: TableExportProgress) => void; reject: (error: Error) => void }> = [];
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    operations.length = 0;
    tables.length = 0;
    mocks.mode.mockResolvedValue("queued");
    mocks.save.mockResolvedValue("C:/exports/original.bson.gz");
    mocks.ensure.mockResolvedValue(undefined);
    mocks.cancel.mockResolvedValue(true);
    mocks.tableCancel.mockResolvedValue(undefined);
    mocks.json.mockReset().mockResolvedValue(undefined);
    mocks.query.mockReset().mockResolvedValue({ columns: ["ID"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 });
    mocks.buildSelect.mockImplementation(async ({ schema, tableName }) => `SELECT * FROM ${schema}.${tableName}`);
    mocks.closeCursor.mockReset().mockResolvedValue(undefined);
    mocks.closeClient.mockReset().mockResolvedValue(undefined);
    mocks.tableExport.mockImplementation((request, progress) => new Promise((resolve, reject) => tables.push({ request, progress, resolve, reject })));
    mocks.export.mockImplementation((request, progress) => new Promise((resolve, reject) => operations.push({ request, progress, resolve, reject })));
  });

  async function fixture() {
    const { useSidebarTreeExportRuntime } = await import("../useSidebarTreeExportRuntime");
    const { useExportTracker } = await import("../useExportTracker");
    const activeNode = shallowRef({ id: "collection", type: "mongo-collection", connectionId: "mongo-1", database: "original", label: "docs" } as TreeNode);
    const config = { id: "mongo-1", db_type: "mongodb", host: "original" };
    const runtime = useSidebarTreeExportRuntime({ activeNode, connectionStore: { getConfig: () => config, ensureConnected: mocks.ensure } as never, settingsStore: { editorSettings: { preferredExportPath: "C:/exports" } } as never, acceptedSelectionIds: () => null });
    return { runtime, tracker: useExportTracker(), activeNode };
  }

  async function tableFixture(multiple = false, dbType = "oracle") {
    const { useSidebarTreeExportRuntime } = await import("../useSidebarTreeExportRuntime");
    const { useExportTracker } = await import("../useExportTracker");
    const first = { id: "first", type: "table", label: "A", connectionId: "oracle-1", database: "XE", schema: "HR" } as TreeNode;
    const second = { ...first, id: "second", label: "B" };
    const activeNode = shallowRef(first);
    const settings = { editorSettings: { exportBatchSize: 123, exportRowLimitEnabled: false, csvQuoteMode: "minimal", csvNullMode: "empty", dataGridExtractorOptions: { sql: { primaryKeyMode: "include" } }, generateSqlIncludeDatabaseName: true } };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: { getConfig: () => ({ id: "oracle-1", db_type: dbType, host: "original" }), ensureConnected: mocks.ensure, connectionIdentifierQuote: () => '"', treeNodes: [first, second], selectedTreeNodeIds: multiple ? [first.id, second.id] : [] } as never,
      settingsStore: settings as never,
      acceptedSelectionIds: () => null,
    });
    return { runtime, tracker: useExportTracker(), activeNode, settings };
  }

  function finishTable(index: number, status: "Done" | "Cancelled" = "Done") {
    const operation = tables[index]!;
    const terminal: TableExportProgress = { exportId: operation.request.exportId, tableName: operation.request.tableName, rowsExported: 10, totalRows: 10, status };
    operation.progress(terminal);
    operation.resolve(terminal);
  }

  it("queues JSON reads and holds the lease through the actual writer", async () => {
    const { runtime, tracker, activeNode } = await tableFixture();
    let release!: () => void;
    tracker.submitExportTask(
      tracker.addTask("blocker", "csv", "first.csv"),
      "immediate",
      () =>
        new Promise((resolve) => {
          release = () => resolve("settled");
        }),
    );
    let written!: () => void;
    mocks.json.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          written = resolve;
        }),
    );
    await runtime.exportData("json");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    activeNode.value = { ...activeNode.value, label: "OTHER", schema: "SECRET" };
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    release();
    await vi.waitFor(() => expect(mocks.json).toHaveBeenCalledOnce());
    expect(mocks.query).toHaveBeenCalledWith("oracle-1", "XE", "SELECT * FROM HR.A");
    expect(mocks.json).toHaveBeenCalledWith("C:/exports/original.bson.gz", ["ID"], [[7]]);
    expect(tracker.tasks.value[1]!.canCancel).toBe(false);
    expect(next).not.toHaveBeenCalled();
    written();
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });

  it.each(["completed", "transport"] as const)("waits for the actual JSON read after cancellation (%s)", async (outcome) => {
    const { runtime, tracker } = await tableFixture();
    let resolve!: (value: QueryResult) => void;
    let reject!: (error: Error) => void;
    mocks.query.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    await runtime.exportData("json");
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledOnce());
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.tableCancel).not.toHaveBeenCalled();
    if (outcome === "transport") reject(new Error("read reply lost"));
    else resolve({ columns: ["ID"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 });
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(outcome === "transport" ? "Unknown" : "Cancelled"));
    expect(mocks.json).not.toHaveBeenCalled();
    if (outcome === "completed") await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    else expect(next).not.toHaveBeenCalled();
  });

  it("keeps a swallowed cursor-close failure unknown and awaits the owned client close", async () => {
    const { runtime, tracker } = await tableFixture(false, "cassandra");
    mocks.query.mockResolvedValueOnce({ columns: ["ID"], rows: [[7]], affected_rows: 0, execution_time_ms: 0, has_more: false, session_id: "cursor-1" });
    mocks.closeCursor.mockRejectedValueOnce(new Error("cursor close reply lost"));
    let close!: () => void;
    mocks.closeClient.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    await runtime.exportData("json");
    await vi.waitFor(() => expect(mocks.closeClient).toHaveBeenCalledOnce());
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    expect(tracker.tasks.value[0]!.status).not.toBe("Done");
    expect(next).not.toHaveBeenCalled();
    close();
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
    expect(mocks.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("captures sidebar table requests while waiting without connecting", async () => {
    const { runtime, tracker, activeNode, settings } = await tableFixture();
    let release!: () => void;
    tracker.submitExportTask(
      tracker.addTask("blocker", "csv", "first.csv"),
      "immediate",
      () =>
        new Promise((resolve) => {
          release = () => resolve("settled");
        }),
    );
    await runtime.exportData("sql");
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(tables).toHaveLength(0);
    activeNode.value = { ...activeNode.value, database: "OTHER", schema: "PRIVATE", label: "SECRET" };
    settings.editorSettings.exportBatchSize = 999;
    release();
    await vi.waitFor(() => expect(tables).toHaveLength(1));
    expect(tables[0]!.request).toMatchObject({ tableName: "A", database: "XE", schema: "HR", batchSize: 123 });
    finishTable(0);
    await vi.waitFor(() => expect(tracker.tasks.value[1]!.status).toBe("Done"));
  });

  it("cancels a waiting table without connecting or sending cancellation RPCs", async () => {
    const { runtime, tracker } = await tableFixture();
    let release!: () => void;
    tracker.submitExportTask(
      tracker.addTask("blocker", "csv", "first.csv"),
      "immediate",
      () =>
        new Promise((resolve) => {
          release = () => resolve("settled");
        }),
    );
    await runtime.exportData("csv");
    await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
    release();
    await Promise.resolve();
    expect(tracker.tasks.value[1]!.status).toBe("Cancelled");
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.tableExport).not.toHaveBeenCalled();
    expect(mocks.tableCancel).not.toHaveBeenCalled();
  });

  it("preserves successful terminal evidence after a late cancel and invoke rejection", async () => {
    const { runtime, tracker } = await tableFixture();
    await runtime.exportData("csv");
    await vi.waitFor(() => expect(tables).toHaveLength(1));
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    const operation = tables[0]!;
    operation.progress({ exportId: operation.request.exportId, tableName: "A", rowsExported: 10, totalRows: 10, status: "Done" });
    expect(next).not.toHaveBeenCalled();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    operation.reject(new Error("invoke reply lost after terminal"));
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(tracker.tasks.value[0]!.status).toBe("Done");
  });

  it("holds one batch lease until every table has completed", async () => {
    const { runtime, tracker } = await tableFixture(true);
    await runtime.exportData("csv");
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    await vi.waitFor(() => expect(tables).toHaveLength(1));
    expect(tables[0]!.request.filePath).toBe("C:/exports/A.csv");
    finishTable(0);
    await vi.waitFor(() => expect(tables).toHaveLength(2));
    expect(tables[1]!.request.filePath).toBe("C:/exports/B.csv");
    expect(next).not.toHaveBeenCalled();
    finishTable(1);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(tracker.tasks.value[0]!.status).toBe("Done");
  });

  it.each(["terminal", "transport"] as const)("does not release a cancelled table batch on cancel acknowledgement (%s)", async (outcome) => {
    const { runtime, tracker } = await tableFixture(true);
    await runtime.exportData("csv");
    await vi.waitFor(() => expect(tables).toHaveLength(1));
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(mocks.tableCancel).toHaveBeenCalledWith(tables[0]!.request.exportId);
    expect(next).not.toHaveBeenCalled();
    if (outcome === "terminal") finishTable(0, "Cancelled");
    else tables[0]!.reject(new Error("reply lost"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(outcome === "terminal" ? "Cancelled" : "Unknown"));
    expect(tables).toHaveLength(1);
    if (outcome === "terminal") await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    else expect(next).not.toHaveBeenCalled();
  });

  it("captures the collection and waits for the actual summary rather than a terminal progress event", async () => {
    const { runtime, tracker, activeNode } = await fixture();
    let release!: () => void;
    const blocker = tracker.addTask("blocker", "csv", "first.csv");
    tracker.submitExportTask(
      blocker,
      "immediate",
      () =>
        new Promise((resolve) => {
          release = () => resolve("settled");
        }),
    );
    await runtime.exportMongoCollection("bsonGzip");
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(operations).toHaveLength(0);
    activeNode.value = { ...activeNode.value, connectionId: "other", database: "private", label: "other" };
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    release();
    await vi.waitFor(() => expect(operations).toHaveLength(1));
    const operation = operations[0]!;
    expect(operation.request).toMatchObject({ connectionId: "mongo-1", database: "original", collection: "docs", format: "bson", gzip: true, filePath: "C:/exports/original.bson.gz" });
    operation.progress({ exportId: operation.request.exportId, status: "done", documentsRead: 2, bytesWritten: 20, elapsedMs: 1 });
    expect(tracker.tasks.value[1]!.status).toBe("Writing");
    expect(next).not.toHaveBeenCalled();
    operation.resolve({ exportId: operation.request.exportId, documentsExported: 2, filePath: operation.request.filePath, elapsedMs: 1 });
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(tracker.tasks.value[1]!.status).toBe("Done");
  });

  it("cancels a waiting collection without connecting or sending an export", async () => {
    const { runtime, tracker } = await fixture();
    let release!: () => void;
    tracker.submitExportTask(
      tracker.addTask("blocker", "csv", "first.csv"),
      "immediate",
      () =>
        new Promise((resolve) => {
          release = () => resolve("settled");
        }),
    );
    await runtime.exportMongoCollection("csv");
    await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
    release();
    await Promise.resolve();
    expect(tracker.tasks.value[1]!.status).toBe("Cancelled");
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("keeps a running cancellation acknowledgement and transport rejection unknown", async () => {
    const { runtime, tracker } = await fixture();
    await runtime.exportMongoCollection("ndjson");
    await vi.waitFor(() => expect(operations).toHaveLength(1));
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(tracker.tasks.value[0]!.status).toBe("Cancelling");
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith(operations[0]!.request.exportId);
    expect(next).not.toHaveBeenCalled();
    operations[0]!.reject(new Error("transport lost"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
    expect(next).not.toHaveBeenCalled();
    expect(tracker.tasks.value[0]!.finishedAt).toBeUndefined();
  });

  it.each(["failed", "cancelled", "unknown"] as const)("uses reported Mongo completion rather than terminal progress (%s)", async (status) => {
    const { runtime, tracker } = await fixture();
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    await runtime.exportMongoCollection("csv");
    await vi.waitFor(() => expect(operations).toHaveLength(1));
    expect(mocks.export.mock.calls[0]![2]).toBe(true);
    const next = vi.fn().mockResolvedValue("settled");
    tracker.submitExportTask(tracker.addTask("next", "csv", "next.csv"), "queued", next);
    const operation = operations[0]!;
    operation.progress({ exportId: operation.request.exportId, status: "cancelled", documentsRead: 1, bytesWritten: 10, elapsedMs: 1 });
    expect(next).not.toHaveBeenCalled();
    operation.reject(new SnapshotCompletionError(status, "completion evidence"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(status === "unknown" ? "Unknown" : status === "cancelled" ? "Cancelled" : "Error"));
    if (status === "unknown") expect(next).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });
});
