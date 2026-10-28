import { computed, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseDataGridExportOptions } from "../useDataGridExport";
import type { TableExportProgress, TableExportRequest, QueryResultExportRequest } from "@/lib/backend/api";
import type { SnapshotExportRequest, LargeValueChunk } from "@/lib/backend/http";
import type { QueryResult } from "@/types/database";
import "../useDataGridExport";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  start: vi.fn(),
  queryStart: vi.fn(),
  queryCancel: vi.fn(),
  snapshot: vi.fn(),
  readChunk: vi.fn(),
  memoryWrite: vi.fn(),
  buildInsert: vi.fn(),
  sqlMode: vi.fn(),
  createTemp: vi.fn(),
  openTemp: vi.fn(),
  cancelQuery: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  toast: vi.fn(),
  ensure: vi.fn(),
  config: { id: "oracle-1", name: "Oracle", db_type: "oracle", host: "test-instance" },
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/export/exportExecutionMode", () => ({ showExportExecutionModeDialog: mocks.mode }));
vi.mock("@/lib/export/sqlInsertMode", () => ({ showSqlInsertModeDialog: mocks.sqlMode }));
vi.mock("@/lib/export/exportPath", () => ({ promptExportSavePath: mocks.save, autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  startTableExport: mocks.start,
  cancelTableExport: mocks.cancel,
  startQueryResultExport: mocks.queryStart,
  cancelQueryResultExport: mocks.queryCancel,
  exportSnapshotResult: mocks.snapshot,
  readLargeValueChunk: mocks.readChunk,
  cancelQuery: mocks.cancelQuery,
  exportQueryResultCsv: mocks.memoryWrite,
  exportQueryResultJson: mocks.memoryWrite,
  exportQueryResultMarkdown: mocks.memoryWrite,
  exportQueryResultHtml: mocks.memoryWrite,
  exportQueryResultXlsx: mocks.memoryWrite,
  exportQueryResultsXlsx: mocks.memoryWrite,
  buildExportSqlInsert: mocks.buildInsert,
  createQueryResultTempFile: mocks.createTemp,
  openQueryResultTempFile: mocks.openTemp,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.memoryWrite }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => mocks.config, ensureConnected: mocks.ensure, connectionStateRevision: () => 0, isCurrentConnectionStateRevision: () => true }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { exportBatchSize: 1000, exportRowLimitEnabled: false, csvQuoteMode: "minimal", csvNullMode: "empty", numericColumnRightAlign: true } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/composables/useDataGridExtractor", () => ({ useDataGridExtractor: () => ({ canCopyWithExtractor: vi.fn() }) }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));

function fixture() {
  const source = reactive({ table: "ORDERS", schema: "HR", filter: "ID > 0", connection: "oracle-1", database: "XE" });
  const progress = ref({ title: "", tableName: "", format: "", rowsExported: 0, totalRows: null as number | null, status: "", errorMessage: null as string | null, filePath: null as string | null, startedAt: undefined as number | undefined, finishedAt: undefined as number | undefined });
  const options: UseDataGridExportOptions = {
    columns: computed(() => ["ID"]),
    displayItems: computed(() => []),
    sql: computed(() => "SELECT ID FROM ORDERS"),
    tableMeta: computed(() => ({ tableName: source.table, schema: source.schema, primaryKeys: ["ID"], columns: [{ name: "ID", data_type: "NUMBER" }] })),
    databaseType: computed(() => "oracle"),
    connectionId: computed(() => source.connection),
    database: computed(() => source.database),
    context: computed(() => "table-data"),
    sourceColumns: computed(() => ["ID"]),
    columnTypes: computed(() => ["NUMBER"]),
    whereInput: computed(() => source.filter),
    orderBy: computed(() => "ID"),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedCellMatrix: computed(() => null),
    selectedRange: computed(() => null),
    contextCell: ref(null),
    contextSelectionIsSynthetic: ref(false),
    getRowItem: () => undefined,
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
    exportProgressState: progress,
    exportProgressDialog: ref(false),
    exportCanMinimize: ref(false),
    exportCancelHandler: ref(null),
  };
  return { source, options, progress };
}

describe("data grid queued table export", () => {
  const pending: Array<{ request: TableExportRequest | QueryResultExportRequest; progress: (progress: TableExportProgress) => void; resolve: (progress: TableExportProgress) => void; reject: (error: Error) => void }> = [];
  const snapshots: Array<{ request: SnapshotExportRequest; path: string; resolve: () => void; reject: (error: Error) => void }> = [];
  const reads: Array<{ resolve: (chunk: LargeValueChunk) => void }> = [];
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { createPinia, setActivePinia } = await import("pinia");
    setActivePinia(createPinia());
    pending.length = 0;
    snapshots.length = 0;
    reads.length = 0;
    mocks.mode.mockResolvedValue("queued");
    let file = 0;
    mocks.save.mockImplementation(async () => `C:/exports/report-${++file}.csv`);
    mocks.cancel.mockResolvedValue(undefined);
    mocks.queryCancel.mockResolvedValue(undefined);
    mocks.cancelQuery.mockResolvedValue(undefined);
    mocks.ensure.mockResolvedValue(undefined);
    mocks.memoryWrite.mockReset().mockResolvedValue(undefined);
    mocks.buildInsert.mockResolvedValue("INSERT original captured SQL");
    mocks.sqlMode.mockResolvedValue({ insertMode: "batch" });
    mocks.createTemp.mockImplementation(async (extension) => `C:/exports/temp.${extension}`);
    mocks.openTemp.mockReset().mockResolvedValue(undefined);
    mocks.start.mockImplementation((request, progress) => new Promise((resolve, reject) => pending.push({ request, progress, resolve, reject })));
    mocks.queryStart.mockImplementation((request, progress) => new Promise((resolve, reject) => pending.push({ request, progress, resolve, reject })));
    mocks.snapshot.mockImplementation((request, path) => new Promise<void>((resolve, reject) => snapshots.push({ request, path, resolve, reject })));
    mocks.readChunk.mockImplementation(() => new Promise<LargeValueChunk>((resolve) => reads.push({ resolve })));
  });

  function finish(index: number, status: "Done" | "Cancelled" = "Done") {
    const item = pending[index]!;
    const progress: TableExportProgress = { exportId: item.request.exportId, tableName: "tableName" in item.request ? item.request.tableName : "Query Result", rowsExported: 10, totalRows: 10, status, errorMessage: null };
    item.progress(progress);
    item.resolve(progress);
  }

  it("accepts another export while waiting, then uses its captured target without overwriting the current dialog", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { source, options, progress } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    source.filter = "ID > 100";
    await grid.exportCsv();
    expect(pending).toHaveLength(1);
    expect(progress.value.status).toBe("Queued");
    expect(progress.value.startedAt).toBeUndefined();
    source.table = "OTHER";
    source.schema = "PRIVATE";
    source.filter = "ID < 0";
    source.database = "OTHER_DATABASE";
    finish(0);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]!.request).toEqual(expect.objectContaining({ tableName: "ORDERS", schema: "HR", database: "XE", whereInput: "ID > 100", filePath: "C:/exports/report-2.csv" }));
    expect(progress.value.filePath).toBe("C:/exports/report-2.csv");
    expect(progress.value.status).toBe("Running");
    expect(useExportTracker().tasks.value[0]!.status).toBe("Done");
    finish(1);
    await vi.waitFor(() => expect(progress.value.status).toBe("Done"));
  });

  it("advances after a confirmed pre-invoke listener failure instead of keeping an unknown lease", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    mocks.start.mockRejectedValueOnce(new SnapshotCompletionError("failed", "listener unavailable"));
    const grid = useDataGridExport(fixture().options);
    await grid.exportCsv();
    await grid.exportCsv();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(useExportTracker().tasks.value[0]!.status).toBe("Error");
    expect(useExportTracker().tasks.value[0]!.errorMessage).toBe("listener unavailable");
    finish(0);
  });

  it("cancels a waiting file without starting a backend export", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { options, progress } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await grid.exportCsv();
    expect(progress.value.status).toBe("Queued");
    await options.exportCancelHandler!.value!();
    expect(progress.value.status).toBe("Cancelled");
    await options.exportCancelHandler!.value?.();
    const { useExportTracker } = await import("../useExportTracker");
    await useExportTracker().cancelTask(useExportTracker().tasks.value[1]!.exportId);
    expect(mocks.cancel).not.toHaveBeenCalled();
    finish(0);
    await Promise.resolve();
    expect(pending).toHaveLength(1);
  });

  it("waits for actual terminal progress after cancellation, not just the cancel response", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { options } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await grid.exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
    finish(0, "Cancelled");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    finish(1);
    await Promise.resolve();
  });

  it("keeps the queue blocked when the started export loses its terminal result", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { options } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await grid.exportCsv();
    pending[0]!.reject(new Error("native connection interrupted"));
    await vi.waitFor(() => expect(useExportTracker().tasks.value[0]!.status).toBe("Unknown"));
    expect(pending).toHaveLength(1);
    expect(useExportTracker().tasks.value[1]!.status).toBe("Queued");
  });

  it("does not start a cancelled export after its pending connection preparation finishes", async () => {
    let connected!: () => void;
    mocks.ensure.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    );
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { options } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await grid.exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(tracker.tasks.value[0]!.status).toBe("Cancelling");
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
    connected();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(tracker.tasks.value[0]!.status).toBe("Cancelled");
    expect(pending[0]!.request.filePath).toBe("C:/exports/report-2.csv");
    finish(0);
    await Promise.resolve();
  });

  it("continues after a confirmed backend error without retrying the failed file", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { options } = fixture();
    const grid = useDataGridExport(options);
    await grid.exportCsv();
    await grid.exportCsv();
    const failed = pending[0]!;
    failed.progress({ exportId: failed.request.exportId, tableName: "ORDERS", rowsExported: 0, totalRows: null, status: "Error", errorMessage: "permission denied" });
    failed.reject(new Error("permission denied"));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(useExportTracker().tasks.value[0]!.status).toBe("Error");
    expect(pending[1]!.request.filePath).toBe("C:/exports/report-2.csv");
    finish(1);
    await Promise.resolve();
  });

  function queryFixture() {
    const result = fixture();
    const querySql = ref("SELECT ID FROM ORIGINAL_QUERY");
    const builders: Array<ReturnType<typeof vi.fn>> = [];
    result.options.context = computed(() => "results");
    result.options.sql = computed(() => querySql.value);
    result.options.queryResultExportRequest = vi.fn(async () => {
      throw new Error("active source callback must not be used for queued requests");
    });
    result.options.captureQueryResultExportRequest = () => {
      const capturedSql = querySql.value;
      const database = result.source.database;
      const schema = result.source.schema;
      const build = vi.fn(async (options) => ({ ...options, connectionId: "oracle-1", database, schema, databaseType: "oracle", sql: capturedSql, queryBaseSql: capturedSql, executionId: `execution-${options.exportId}` }));
      builders.push(build);
      return build;
    };
    return { ...result, querySql, builders };
  }

  it("keeps queued query preparation behind table exports and consumes the captured request only", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const query = queryFixture();
    await useDataGridExport(query.options).exportCsv();
    expect(query.builders).toHaveLength(2);
    expect(query.builders.every((builder) => builder.mock.calls.length === 0)).toBe(true);
    query.querySql.value = "SELECT SECRET FROM NEW_QUERY";
    query.source.database = "OTHER_DATABASE";
    query.source.schema = "PRIVATE";
    finish(0);
    await vi.waitFor(() => expect(mocks.queryStart).toHaveBeenCalledOnce());
    expect(pending[1]!.request).toEqual(expect.objectContaining({ database: "XE", schema: "HR", sql: "SELECT ID FROM ORIGINAL_QUERY", filePath: "C:/exports/report-2.csv" }));
    expect(query.builders[0]).not.toHaveBeenCalled();
    expect(query.builders[1]).toHaveBeenCalledOnce();
    expect(query.options.queryResultExportRequest).not.toHaveBeenCalled();
    finish(1);
    await Promise.resolve();
  });

  it("cancels a running query using its captured execution id and waits for terminal cleanup", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(queryFixture().options).exportCsv();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    const task = useExportTracker().tasks.value[0]!;
    await useExportTracker().cancelTask(task.exportId);
    expect(mocks.queryCancel).toHaveBeenCalledWith(task.exportId, `execution-${task.exportId}`);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    finish(0, "Cancelled");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    finish(1);
    await Promise.resolve();
  });

  function lobFixture(formatted = false) {
    const result = fixture();
    const snapshot = ref<QueryResult>({
      columns: ["ID"],
      column_types: ["CLOB"],
      rows: [["preview"]],
      affected_rows: 0,
      execution_time_ms: 0,
      large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 10, value_ref: "original-lob" }],
      large_value_context: { connectionId: "oracle-1", database: "XE" },
    });
    const formatter = ref("original");
    result.options.context = computed(() => "results");
    result.options.columnTypes = computed(() => ["CLOB"]);
    result.options.snapshotResult = computed(() => snapshot.value);
    result.options.completeLocalResult = computed(() => snapshot.value);
    result.options.hasCompleteLocalResult = computed(() => true);
    result.options.hasColumnFormatter = () => formatted;
    result.options.applyColumnFormattersOnExport = computed(() => true);
    result.options.displayValue = (value) => `${formatter.value}:${value}`;
    result.options.captureColumnFormatterDisplay = () => {
      const pattern = formatter.value;
      return (value) => `${pattern}:${value}`;
    };
    return { ...result, snapshot, formatter };
  }

  it.each(["exportCsv", "exportJson", "exportMarkdown", "exportHtml", "exportTxt"] as const)("defers captured legacy values for %s and keeps the original formatter", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const legacy = lobFixture(true);
    delete legacy.snapshot.value.large_value_cells![0]!.value_ref;
    const read = vi.fn().mockResolvedValue(new Map([[0, new Map([[0, "complete original"]])]]));
    const capture = vi.fn(() => read);
    legacy.options.captureSourceValues = capture;
    await useDataGridExport(legacy.options)[method]();
    expect(capture).toHaveBeenCalledWith([expect.objectContaining({ rowId: 0, sourceIndex: 0, columnIndex: 0 })]);
    expect(read).not.toHaveBeenCalled();
    legacy.snapshot.value = { ...legacy.snapshot.value, rows: [["new preview"]] };
    legacy.source.connection = "other";
    legacy.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.memoryWrite.mock.calls[0])).toContain("original:complete original");
    expect(mocks.readChunk).not.toHaveBeenCalled();
  });

  it.each(["exportSql", "exportXlsx"] as const)("resolves captured legacy values before %s and preserves format semantics", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const legacy = lobFixture(true);
    legacy.options.hasUniqueQueryInsertTarget = computed(() => true);
    legacy.options.currentResultLabel = computed(() => legacy.source.table);
    delete legacy.snapshot.value.large_value_cells![0]!.value_ref;
    const read = vi.fn().mockResolvedValue(new Map([[0, new Map([[0, "complete original"]])]]));
    legacy.options.captureSourceValues = () => read;
    await useDataGridExport(legacy.options)[method]();
    expect(read).not.toHaveBeenCalled();
    legacy.source.table = "OTHER";
    legacy.source.schema = "PRIVATE";
    legacy.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
    if (method === "exportSql") {
      expect(mocks.buildInsert).toHaveBeenCalledWith(expect.objectContaining({ schema: "HR", tableName: "ORDERS", rows: [["complete original"]] }));
    } else {
      expect(mocks.memoryWrite.mock.calls[0]![5]).toEqual([["original:complete original"]]);
    }
    expect(legacy.snapshot.value.rows).toEqual([["preview"]]);
    expect(mocks.readChunk).not.toHaveBeenCalled();
  });

  it.each(["exportCsv", "exportJson", "exportMarkdown", "exportHtml", "exportTxt"] as const)("queues captured full-provider data for %s without calling the active provider", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const partial = lobFixture(true);
    partial.options.hasCompleteLocalResult = computed(() => false);
    const activeProvider = vi.fn();
    const read = vi.fn().mockResolvedValue({ columns: ["ID"], column_types: ["CLOB"], rows: [["full original"]], has_more: false, truncated: false, execution_time_ms: 0, affected_rows: 0 });
    const capture = vi.fn(() => read);
    partial.options.fullExportResult = activeProvider;
    partial.options.captureFullExportResult = capture;
    await useDataGridExport(partial.options)[method]();
    expect(capture).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    partial.source.connection = "other";
    partial.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(activeProvider).not.toHaveBeenCalled();
    expect(read.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(mocks.memoryWrite.mock.calls[0])).toContain("original:full original");
  });

  it.each(["exportSql", "exportXlsx"] as const)("uses captured target and returned full metadata for %s", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const partial = lobFixture(true);
    partial.options.hasUniqueQueryInsertTarget = computed(() => true);
    partial.options.hasCompleteLocalResult = computed(() => false);
    partial.options.currentResultLabel = computed(() => partial.source.table);
    const read = vi.fn().mockResolvedValue({ columns: ["ID", "BODY"], column_types: ["NUMBER", "CLOB"], rows: [[7, "full original"]], has_more: false, execution_time_ms: 0, affected_rows: 0 });
    partial.options.captureFullExportResult = () => read;
    await useDataGridExport(partial.options)[method]();
    expect(read).not.toHaveBeenCalled();
    partial.source.table = "OTHER";
    partial.source.schema = "PRIVATE";
    partial.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    if (method === "exportSql") expect(mocks.buildInsert).toHaveBeenCalledWith(expect.objectContaining({ schema: "HR", tableName: "ORDERS", columns: ["ID", "BODY"], columnTypes: ["NUMBER", "CLOB"], rows: [[7, "full original"]] }));
    else {
      expect(mocks.memoryWrite.mock.calls[0]![1]).toBe("ORDERS");
      expect(mocks.memoryWrite.mock.calls[0]![2]).toEqual(["ID", "BODY"]);
      expect(mocks.memoryWrite.mock.calls[0]![3]).toEqual(["NUMBER", "CLOB"]);
      expect(mocks.memoryWrite.mock.calls[0]![5]).toEqual([["original:7", "full original"]]);
    }
  });

  it("does not release a full-provider lease after a cancelled read rejects with unknown completion", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    const partial = lobFixture();
    partial.options.hasCompleteLocalResult = computed(() => false);
    let rejectRead!: (error: Error) => void;
    const read = vi.fn<(progress?: unknown, control?: { signal: AbortSignal }) => Promise<never>>(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    partial.options.captureFullExportResult = () => read;
    await useDataGridExport(partial.options).exportCsv();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(read.mock.calls[0]![1]!.signal.aborted).toBe(true);
    expect(pending).toHaveLength(0);
    rejectRead(new SnapshotCompletionError("unknown", "transport lost"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
    expect(pending).toHaveLength(0);
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
  });

  it("keeps a legacy read's unknown outcome when cancellation arrives first", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    const legacy = lobFixture();
    delete legacy.snapshot.value.large_value_cells![0]!.value_ref;
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(
      () =>
        new Promise<Map<number, Map<number, string>>>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    legacy.options.captureSourceValues = () => read;
    await useDataGridExport(legacy.options).exportCsv();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(pending).toHaveLength(0);
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    rejectRead(new SnapshotCompletionError("unknown", "transport lost"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
    expect(pending).toHaveLength(0);
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
  });

  it("does not start a queued LOB read or write while another export owns the queue", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(fixture().options).exportCsv();
    await useDataGridExport(lobFixture(true).options).exportCsv();
    expect(reads).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
    await useExportTracker().cancelTask(useExportTracker().tasks.value[1]!.exportId);
    finish(0);
    await Promise.resolve();
    expect(reads).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("retains native LOB materialization after local abort and does not write cancelled values", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(lobFixture(true).options).exportCsv();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(mocks.cancelQuery).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(0);
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(tracker.tasks.value[0]!.status).toBe("Cancelled");
    expect(snapshots).toHaveLength(0);
    finish(0);
    await Promise.resolve();
  });

  it("waits for a native snapshot write and reports real success if cancellation arrives after commit", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(lobFixture().options).exportCsv();
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(pending).toHaveLength(0);
    expect(mocks.snapshot.mock.calls[0]![2]).toBeUndefined();
    snapshots[0]!.resolve();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(tracker.tasks.value[0]!.status).toBe("Done");
    finish(0);
    await Promise.resolve();
  });

  it("uses the formatter captured before waiting rather than a changed grid formatter", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const lob = lobFixture(true);
    await useDataGridExport(lob.options).exportCsv();
    lob.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0]!.request.rows).toEqual([["original:complete"]]);
    expect(snapshots[0]!.request.cells).toEqual([]);
    snapshots[0]!.resolve();
    await Promise.resolve();
  });

  it.each(["failed", "cancelled", "unknown"] as const)("uses confirmed snapshot %s without treating cancel acknowledgement as completion", async (status) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    await useDataGridExport(lobFixture().options).exportCsv();
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(pending).toHaveLength(0);
    snapshots[0]!.reject(new SnapshotCompletionError(status, "original disk/read failure"));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(status === "failed" ? "Error" : status === "cancelled" ? "Cancelled" : "Unknown"));
    if (status === "unknown") {
      expect(pending).toHaveLength(0);
      await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
    } else {
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      finish(0);
    }
  });

  it.each([false, true])("queues a plain selected column without resolving an excluded LOB (complete=%s)", async (complete) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    const original = ref<QueryResult>({ columns: ["ID", "BODY"], column_types: ["NUMBER", "CLOB"], rows: [[7, "preview"]], affected_rows: 0, execution_time_ms: 0, large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 5000 }] });
    memory.options.context = computed(() => "results");
    memory.options.columns = computed(() => ["ID", "BODY"]);
    memory.options.columnTypes = computed(() => ["NUMBER", "CLOB"]);
    memory.options.sourceColumns = computed(() => ["ID", "BODY"]);
    memory.options.snapshotResult = computed(() => original.value);
    memory.options.completeLocalResult = computed(() => (complete ? original.value : undefined));
    memory.options.hasCompleteLocalResult = computed(() => complete);
    memory.options.displayItems = computed(() => [{ id: 1, sourceIndex: 0, data: [7, "preview"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "normal" }]);
    const resolver = vi.fn();
    memory.options.resolveSourceValues = resolver;
    await useDataGridExport(memory.options).exportCsv({ rowIds: [1], columnIndexes: [0] });
    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    memory.source.connection = "different";
    original.value = { ...original.value, rows: [[999, "different"]] };
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.memoryWrite.mock.calls[0]!.slice(1, 3)).toEqual([["ID"], [[7]]]);
    expect(mocks.readChunk).not.toHaveBeenCalled();
  });

  it.each(["exportCsv", "exportJson", "exportMarkdown", "exportHtml", "exportTxt"] as const)("queues %s complete memory values without requerying or reading changed data", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    const original = ref<QueryResult>({ columns: ["ID"], column_types: ["NUMBER"], rows: [[7], [8]], affected_rows: 0, execution_time_ms: 0 });
    memory.options.context = computed(() => "results");
    memory.options.hasCompleteLocalResult = computed(() => true);
    memory.options.completeLocalResult = computed(() => original.value);
    const provider = vi.fn();
    memory.options.fullExportResult = provider;
    await useDataGridExport(memory.options)[method]();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    original.value.rows[0]![0] = 999;
    original.value = { ...original.value, rows: [[123]] };
    memory.source.database = "OTHER";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    const args = mocks.memoryWrite.mock.calls[0]!;
    if (method === "exportTxt") {
      expect(args[1]).toContain("7");
      expect(args[1]).not.toContain("999");
    } else expect(args[method === "exportHtml" ? 3 : 2]).toEqual([[7], [8]]);
    expect(provider).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.queryStart).not.toHaveBeenCalled();
  });

  it.each([false, true])("captures workbook rows, sheet title and included SQL before waiting (SQL sheet: %s)", async (includeSql) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    const original = ref<QueryResult>({ columns: ["ID"], column_types: ["NUMBER"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 });
    const sourceSql = ref("SELECT 7 FROM dual");
    const label = ref("Original sheet");
    memory.options.sql = computed(() => sourceSql.value);
    memory.options.currentResultLabel = computed(() => label.value);
    memory.options.context = computed(() => "results");
    memory.options.hasCompleteLocalResult = computed(() => true);
    memory.options.completeLocalResult = computed(() => original.value);
    const grid = useDataGridExport(memory.options);
    if (includeSql) await grid.exportXlsxWithSql();
    else await grid.exportXlsx();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    sourceSql.value = "SELECT secret FROM other_schema";
    label.value = "Other sheet";
    original.value.rows[0]![0] = 999;
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    const args = mocks.memoryWrite.mock.calls[0]!;
    if (includeSql) {
      expect(args[1][0]).toEqual(expect.objectContaining({ sheetName: "Original sheet", rows: [[7]] }));
      expect(JSON.stringify(args[1][1])).toContain("SELECT 7 FROM dual");
      expect(JSON.stringify(args[1][1])).not.toContain("secret");
    } else {
      expect(args[1]).toBe("Original sheet");
      expect(args[5]).toEqual([[7]]);
    }
  });

  it("captures the SQL insert target and data while postponing generation and file writing", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    const original = ref<QueryResult>({ columns: ["ID"], column_types: ["NUMBER"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 });
    memory.options.context = computed(() => "results");
    memory.options.hasUniqueQueryInsertTarget = computed(() => true);
    memory.options.hasCompleteLocalResult = computed(() => true);
    memory.options.completeLocalResult = computed(() => original.value);
    mocks.sqlMode.mockResolvedValue({ insertMode: "single", executionMode: "queued" });
    await useDataGridExport(memory.options).exportSql();
    expect(mocks.mode).toHaveBeenCalledTimes(1);
    expect(mocks.buildInsert).not.toHaveBeenCalled();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    memory.source.table = "OTHER";
    memory.source.schema = "PRIVATE";
    original.value.rows[0]![0] = 999;
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.buildInsert).toHaveBeenCalledWith(expect.objectContaining({ tableName: "ORDERS", schema: "HR", columns: ["ID"], columnTypes: ["NUMBER"], rows: [[7]], batchSize: 1 }));
    expect(mocks.memoryWrite.mock.calls[0]![1]).toBe("INSERT original captured SQL");
  });

  it.each([false, true])("queues all memory result sheets as one captured workbook (SQL sheet: %s)", async (includeSql) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    const sheets = ref([
      { sheetName: "First", sql: "SELECT 7 FROM dual", result: { columns: ["ID"], column_types: ["NUMBER"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 } },
      { sheetName: "Second", sql: "SELECT 8 FROM dual", result: { columns: ["ID"], column_types: ["NUMBER"], rows: [[8]], affected_rows: 0, execution_time_ms: 0 } },
    ]);
    memory.options.allExportResults = computed(() => sheets.value);
    const grid = useDataGridExport(memory.options);
    if (includeSql) await grid.exportAllResultsXlsxWithSql();
    else await grid.exportAllResultsXlsx();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    sheets.value[0]!.sheetName = "Changed";
    sheets.value[0]!.sql = "SELECT secret FROM other_schema";
    sheets.value[0]!.result.rows[0]![0] = 999;
    sheets.value = [];
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    const exported = mocks.memoryWrite.mock.calls[0]![1];
    expect(exported).toHaveLength(includeSql ? 3 : 2);
    expect(exported[0]).toEqual(expect.objectContaining({ sheetName: "First", rows: [[7]] }));
    expect(exported[1]).toEqual(expect.objectContaining({ sheetName: "Second", rows: [[8]] }));
    if (includeSql) {
      expect(JSON.stringify(exported[2])).toContain("SELECT 7 FROM dual");
      expect(JSON.stringify(exported[2])).not.toContain("secret");
    }
  });

  it("cancels an entire queued memory workbook without generating or writing child sheets", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    memory.options.allExportResults = computed(() => [{ sheetName: "First", result: { columns: ["ID"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 } }]);
    await useDataGridExport(memory.options).exportAllResultsXlsx();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
    finish(0);
    await Promise.resolve();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    expect(tracker.tasks.value[1]!.status).toBe("Cancelled");
  });

  it.each(["xlsx", "html"] as const)("counts %s memory writes as immediate without another execution-mode prompt", async (format) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = fixture();
    memory.options.context = computed(() => "results");
    memory.options.hasCompleteLocalResult = computed(() => true);
    memory.options.completeLocalResult = computed(() => ({ columns: ["ID"], column_types: ["NUMBER"], rows: [[7]], affected_rows: 0, execution_time_ms: 0 }));
    let finishWrite!: () => void;
    let finishOpen!: () => void;
    mocks.memoryWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    mocks.openTemp.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const grid = useDataGridExport(memory.options);
    const opening = format === "xlsx" ? grid.openXlsx() : grid.exportHtml(undefined, true);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.mode).toHaveBeenCalledOnce();
    expect(mocks.createTemp).toHaveBeenCalledWith(format);
    await useDataGridExport(fixture().options).exportCsv();
    finish(0);
    expect(pending).toHaveLength(1);
    finishWrite();
    await vi.waitFor(() => expect(mocks.openTemp).toHaveBeenCalledOnce());
    expect(pending).toHaveLength(1);
    finishOpen();
    await opening;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    finish(1);
  });

  it("captures each legacy sheet before waiting and writes only resolved private rows", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const legacy: QueryResult = { columns: ["ID", "BODY"], rows: [[7, "preview"]], large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 100 }], affected_rows: 0, execution_time_ms: 0 };
    let resolveRead!: (values: Map<number, Map<number, string>>) => void;
    const read = vi.fn(
      () =>
        new Promise<Map<number, Map<number, string>>>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const capture = vi.fn(() => ({ read }));
    const memory = fixture();
    await useDataGridExport(memory.options).exportResultSheetsXlsx([
      { sheetName: "Plain", result: { columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 } },
      { sheetName: "Other table", result: legacy, captureSourceValues: capture },
    ]);
    expect(capture).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    await useDataGridExport(fixture().options).exportCsv();
    finish(0);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    resolveRead(new Map([[0, new Map([[1, "complete body"]])]]));
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.memoryWrite.mock.calls[0]![1]).toEqual([expect.objectContaining({ sheetName: "Plain", rows: [[1]] }), expect.objectContaining({ sheetName: "Other table", rows: [[7, "complete body"]] })]);
    expect(legacy.rows).toEqual([[7, "preview"]]);
    expect(legacy.large_value_cells).toHaveLength(1);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    finish(1);
  });

  it("fails the whole legacy workbook before reading any sheet when a source is unavailable", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const legacy: QueryResult = { columns: ["BODY"], rows: [["preview"]], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100 }], affected_rows: 0, execution_time_ms: 0 };
    const read = vi.fn();
    await useDataGridExport(fixture().options).exportResultSheetsXlsx([
      { sheetName: "Known", result: legacy, captureSourceValues: () => ({ read }) },
      { sheetName: "Unknown", result: legacy },
    ]);
    await vi.waitFor(() => expect(useExportTracker().tasks.value[0]!.status).toBe("Error"));
    expect(useExportTracker().tasks.value[0]!.errorMessage).toContain("Unknown:");
    expect(read).not.toHaveBeenCalled();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    await useDataGridExport(fixture().options).exportCsv();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    finish(0);
  });

  it.each(["completed", "unknown"] as const)("waits for the legacy sheet read after cancellation and preserves %s completion", async (completion) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    let resolveRead!: (values: Map<number, Map<number, string>>) => void;
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(
      () =>
        new Promise<Map<number, Map<number, string>>>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
    );
    await useDataGridExport(fixture().options).exportResultSheetsXlsx([
      { sheetName: "Legacy", result: { columns: ["BODY"], rows: [["preview"]], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100 }], affected_rows: 0, execution_time_ms: 0 }, captureSourceValues: () => ({ read }) },
    ]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(tracker.tasks.value[0]!.status).toBe("Cancelling");
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
    if (completion === "unknown") rejectRead(new SnapshotCompletionError("unknown", "read reply unavailable"));
    else resolveRead(new Map([[0, new Map([[0, "complete"]])]]));
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(completion === "unknown" ? "Unknown" : "Cancelled"));
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    if (completion === "completed") {
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      finish(0);
    } else expect(pending).toHaveLength(0);
  });

  it("holds one workbook lease across both LOB sheets and the actual file write", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(fixture().options).exportCsv();
    const lob = lobFixture();
    const second: QueryResult = { ...lob.snapshot.value, rows: [["second preview"]], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 10, value_ref: "second-lob" }] };
    const sheets = ref([
      { sheetName: "First", result: lob.snapshot.value },
      { sheetName: "Second", result: second },
    ]);
    lob.options.allExportResults = computed(() => sheets.value);
    let finishWrite!: () => void;
    mocks.memoryWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    await useDataGridExport(lob.options).exportAllResultsXlsx();
    expect(reads).toHaveLength(0);
    await useDataGridExport(fixture().options).exportCsv();
    sheets.value[0]!.sheetName = "Changed";
    finish(0);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(pending).toHaveLength(1);
    reads[0]!.resolve({ status: "ok", data: "first complete", next_offset: 14, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(mocks.readChunk.mock.calls[1]![0]).toMatchObject({ valueRef: "second-lob" });
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    reads[1]!.resolve({ status: "ok", data: "second complete", next_offset: 15, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.memoryWrite.mock.calls[0]![1]).toEqual([expect.objectContaining({ sheetName: "First", rows: [["first complete"]] }), expect.objectContaining({ sheetName: "Second", rows: [["second complete"]] })]);
    expect(useExportTracker().tasks.value[1]!.canCancel).toBe(false);
    expect(pending).toHaveLength(1);
    finishWrite();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    finish(1);
  });

  it.each(["completed", "unknown"] as const)("waits for a cancelled LOB workbook block and preserves %s completion", async (completion) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    const { SnapshotCompletionError } = await import("@/lib/export/snapshotCompletion");
    const lob = lobFixture();
    lob.options.allExportResults = computed(() => [
      { sheetName: "First", result: lob.snapshot.value },
      { sheetName: "Second", result: lob.snapshot.value },
    ]);
    let rejectRead!: (error: Error) => void;
    if (completion === "unknown")
      mocks.readChunk.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject;
          }),
      );
    await useDataGridExport(lob.options).exportAllResultsXlsx();
    await vi.waitFor(() => expect(mocks.readChunk).toHaveBeenCalledOnce());
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(pending).toHaveLength(0);
    if (completion === "unknown") rejectRead(new SnapshotCompletionError("unknown", "transport lost"));
    else reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe(completion === "unknown" ? "Unknown" : "Cancelled"));
    expect(mocks.readChunk).toHaveBeenCalledOnce();
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    if (completion === "completed") {
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      finish(0);
    } else expect(pending).toHaveLength(0);
  });

  it.each(["exportXlsx", "exportMarkdown", "exportHtml", "exportTxt", "exportSql"] as const)("queues complete LOB materialization for %s before writing", async (method) => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const lob = lobFixture(method === "exportXlsx" || method === "exportSql");
    await useDataGridExport(lob.options)[method]();
    expect(reads).toHaveLength(0);
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    lob.formatter.value = "changed";
    finish(0);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(mocks.readChunk.mock.calls[0]![1]).toBe(true);
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    const args = mocks.memoryWrite.mock.calls[0]!;
    if (method === "exportXlsx") expect(args[5]).toEqual([["original:complete"]]);
    else if (method === "exportHtml") expect(args[3]).toEqual([["complete"]]);
    else if (method === "exportMarkdown") expect(args[2]).toEqual([["complete"]]);
    else if (method === "exportTxt") expect(args[1]).toContain("complete");
    else expect(mocks.buildInsert).toHaveBeenCalledWith(expect.objectContaining({ rows: [["complete"]] }));
    expect(snapshots).toHaveLength(0);
  });

  it("retains an unformatted XLSX LOB read after cancellation until the original response returns", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(lobFixture().options).exportXlsx();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    const tracker = useExportTracker();
    await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
    expect(pending).toHaveLength(0);
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(tracker.tasks.value[0]!.status).toBe("Cancelled");
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    finish(0);
  });

  it("finishes a known XLSX cell-length failure without writing, then permits the next queued export", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    await useDataGridExport(fixture().options).exportCsv();
    mocks.readChunk.mockImplementation(async (request) => ({ status: "ok", data: "x".repeat(4096), next_offset: request.offset + 4096, eof: request.offset + 4096 === 32768, value_kind: "text" }));
    await useDataGridExport(lobFixture().options).exportXlsx();
    await useDataGridExport(fixture().options).exportCsv();
    finish(0);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(useExportTracker().tasks.value[1]!.status).toBe("Error");
    expect(mocks.memoryWrite).not.toHaveBeenCalled();
    expect(mocks.readChunk).toHaveBeenCalledTimes(8);
    finish(1);
  });

  it("disables cancellation while a native workbook writer runs and holds the lease until it returns", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    const { useExportTracker } = await import("../useExportTracker");
    let finishWrite!: () => void;
    mocks.memoryWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const lob = lobFixture();
    await useDataGridExport(lob.options).exportXlsx();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await useDataGridExport(fixture().options).exportCsv();
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(useExportTracker().tasks.value[0]!.canCancel).toBe(false);
    expect(lob.options.exportCancelHandler!.value).toBeNull();
    expect(pending).toHaveLength(0);
    finishWrite();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(useExportTracker().tasks.value[0]!.status).toBe("Done");
    finish(0);
  });

  it("opens a LOB workbook immediately without another mode prompt while retaining its execution lease", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    let finishWrite!: () => void;
    mocks.memoryWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const opening = useDataGridExport(lobFixture().options).openXlsx();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(mocks.mode).toHaveBeenCalledTimes(1);
    expect(mocks.createTemp).toHaveBeenCalledWith("xlsx");
    await useDataGridExport(fixture().options).exportCsv();
    finish(0);
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    reads[0]!.resolve({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(pending).toHaveLength(1);
    finishWrite();
    await opening;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(mocks.openTemp).toHaveBeenCalledWith("C:/exports/temp.xlsx");
    finish(1);
  });

  it("queues already materialized values even when the result retains old locator references", async () => {
    const { useDataGridExport } = await import("../useDataGridExport");
    await useDataGridExport(fixture().options).exportCsv();
    const memory = lobFixture();
    memory.snapshot.value.rows = [["hydrated complete value"]];
    memory.snapshot.value.large_value_cells = [];
    memory.snapshot.value.large_value_refs = ["retired-locator"];
    await useDataGridExport(memory.options).exportCsv();
    memory.source.connection = "other-connection";
    finish(0);
    await vi.waitFor(() => expect(mocks.memoryWrite).toHaveBeenCalledOnce());
    expect(mocks.memoryWrite.mock.calls[0]![2]).toEqual([["hydrated complete value"]]);
    expect(mocks.readChunk).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
  });
});
