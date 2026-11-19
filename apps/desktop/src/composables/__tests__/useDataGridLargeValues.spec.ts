// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryCellDisplayText, binaryCellDownloadPayload } from "@/lib/dataGrid/binaryCellDownload";
import { useDataGridLargeValues } from "@/composables/useDataGridLargeValues";
import { useDataGridEditor } from "@/composables/useDataGridEditor";
import { createDataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";
import { fetchLegacyLargeValueRequestChunk, type LegacyLargeValueContext, type LegacyResolvedLargeValueCells } from "@/lib/dataGrid/legacyLargeValueExport";
import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildDataGridContextFilterCondition: vi.fn(),
  buildTableSelectSql: vi.fn(),
  cancelQuery: vi.fn(),
  executeMulti: vi.fn(),
  readLargeValueChunk: vi.fn(),
  downloadLargeValue: vi.fn(),
  prepareDataGridSave: vi.fn(),
  executeBatch: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  cancelQuery: mocks.cancelQuery,
  executeMulti: mocks.executeMulti,
  readLargeValueChunk: mocks.readLargeValueChunk,
  downloadLargeValue: mocks.downloadLargeValue,
  prepareDataGridSave: mocks.prepareDataGridSave,
  executeBatch: mocks.executeBatch,
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/table/tableSelectSql", () => ({ buildTableSelectSql: mocks.buildTableSelectSql }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => undefined }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({}) }));

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function mountLargeValues(databaseType: DatabaseType, result: Ref<QueryResult>, withEditor = false, settings: { primaryKeys?: string[]; visible?: boolean; legacy?: boolean } = {}) {
  const config = ref({ id: `${databaseType}-1`, name: "Test", db_type: databaseType, host: "original", url_params: settings.legacy ? "dataCharset=GBK" : undefined } as ConnectionConfig);
  const runtimeScope = createDataGridRuntimeScope();
  const toast = vi.fn();
  const formatCell = (value: unknown, columnIndex?: number, originalBytes?: number) => binaryCellDisplayText(value, result.value.column_types?.[columnIndex ?? 0], originalBytes, databaseType) ?? String(value ?? "");
  const item = (rowId = 1) => ({ id: rowId, sourceIndex: rowId - 1, data: result.value.rows[rowId - 1]!, isNew: false, isDeleted: false, isDirtyCol: [false, false] });
  let largeValues: ReturnType<typeof useDataGridLargeValues> | undefined;
  let editor: ReturnType<typeof useDataGridEditor> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        largeValues = useDataGridLargeValues({
          result: computed(() => result.value),
          tableMeta: computed(() => ({
            schema: "public",
            tableName: "APP_DATA",
            tableType: "TABLE",
            columns: result.value.columns.map((name, index) => ({ name, data_type: result.value.column_types![index]!, is_nullable: index !== 0, column_default: null, is_primary_key: index === 0, extra: null })),
            primaryKeys: settings.primaryKeys ?? ["ID"],
          })),
          databaseType: computed(() => databaseType),
          connectionId: computed(() => `${databaseType}-1`),
          executionDatabase: computed(() => "MAXIMO"),
          resultSourceColumns: computed(() => result.value.columns),
          allColumnTypes: computed(() => result.value.column_types ?? []),
          renderedGridColumns: computed(() => (settings.visible ? result.value.columns.map((_, actualColIdx) => ({ actualColIdx })) : [])),
          showTranspose: ref(false),
          displayRowCount: computed(() => result.value.rows.length),
          gridScrollerElement: () => (settings.visible ? ({ scrollTop: 0, clientHeight: 200 } as HTMLElement) : null),
          displayItemAt: (index) => item(index + 1),
          getRowItem: (rowId) => (rowId >= 1 && rowId <= result.value.rows.length ? item(rowId) : undefined),
          tableColumnForGridColumn: () => undefined,
          formatCell,
          formatCellCached: formatCell,
          scheduleCanvasDraw: vi.fn(),
          clearCellFormatCache: vi.fn(),
          invalidateResultEstimate: vi.fn(),
          connectionIdentifierQuote: () => '"',
          getConnectionConfig: () => config.value,
          includeDatabaseName: computed(() => true),
          globalQueryTimeoutSecs: computed(() => 30),
          resultLifecycle: { beginOperation: () => 1, isCurrent: () => true },
          largeValueResolutionVersion: ref(0),
          runtimeScope,
          uuid: () => "execution-1",
          translate: (key) => key,
          translateBackendError: (error) => String(error),
          appendDebugLog: vi.fn(),
          toast,
          cloneRow: vi.fn(),
          cloneRows: vi.fn(),
        });
        if (withEditor)
          editor = useDataGridEditor({
            result: computed(() => result.value),
            editable: computed(() => true),
            databaseType: computed(() => databaseType),
            connectionId: computed(() => `${databaseType}-1`),
            database: computed(() => "MAXIMO"),
            tableMeta: computed(() => ({
              schema: "public",
              tableName: "APP_DATA",
              columns: result.value.columns.map((name, index) => ({ name, data_type: index === 0 ? "NUMBER" : "CLOB" })),
              primaryKeys: ["ID"],
            })),
            sourceColumns: computed(() => result.value.columns),
            onExecuteSql: computed(() => undefined),
            sql: computed(() => undefined),
            searchText: ref(""),
            dataGridQuickEntryEnabled: computed(() => false),
            whereFilterInput: ref(""),
            currentWhereInput: computed(() => undefined),
            orderByInput: ref(""),
            rowStatusFilter: ref("all"),
            confirmDangerousRowDeletion: computed(() => false),
            pageSize: ref(100),
            currentPage: ref(1),
            getRowItem: (rowId) => ({ id: rowId, sourceIndex: rowId, data: result.value.rows[rowId]!, isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "normal" }),
            prepareSaveBaseline: (changes) => largeValues!.prepareSaveBaseline(changes),
            emit: vi.fn(),
          });
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  disposers.push(() => {
    runtimeScope.dispose();
    app.unmount();
  });
  if (!largeValues) throw new Error("useDataGridLargeValues was not mounted");
  return { largeValues, toast, item, editor, runtimeScope, config };
}

function previewResult(columnType = "bytea", value = "\\x00017f80ff...", originalBytes = 9645) {
  return ref<QueryResult>({
    columns: ["ID", "APP"],
    column_types: ["int4", columnType],
    rows: [[1, value]],
    affected_rows: 0,
    execution_time_ms: 1,
    large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: originalBytes }],
  });
}

describe("useDataGridLargeValues", () => {
  it.each(["metadata", "target"] as const)("uses target identity rather than incidental connection fields for legacy exports (%s)", async (change) => {
    const result = previewResult();
    const { largeValues, config } = mountLargeValues("postgres", result);
    const run = largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }]);
    if (change === "metadata") Object.assign(config.value, { note: "updated note", default_schema: "other display schema", database_info: { product_name: "PostgreSQL" } });
    else config.value.host = "other target";
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue("original select");
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [[1, "complete"]] }]);
    if (change === "metadata") expect((await run(new AbortController().signal)).get(1)?.get(1)).toBe("complete");
    else {
      await expect(run(new AbortController().signal)).rejects.toMatchObject({ status: "failed" });
      expect(mocks.executeMulti).not.toHaveBeenCalled();
    }
  });
  it("captures legacy PK values and columns before deferred export reads", async () => {
    const result = previewResult();
    const { largeValues } = mountLargeValues("postgres", result);
    const run = largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }]);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    result.value = { ...result.value, columns: ["NEW_ID", "OTHER"], rows: [[99, "different"]] };
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue("original select");
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [[1, "complete"]] }]);
    const values = await run(new AbortController().signal);
    expect(mocks.buildDataGridContextFilterCondition).toHaveBeenCalledWith(expect.objectContaining({ columnName: "ID", value: 1 }));
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ tableName: "APP_DATA", columns: ["ID", "APP"] }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("postgres-1", "MAXIMO", "original select", undefined, "execution-1", expect.objectContaining({ maxRows: 1 }));
    expect(values.get(1)?.get(1)).toBe("complete");
  });

  it.each(["resolve", "reject"] as const)("waits for an in-flight legacy export read on cancellation (%s)", async (completion) => {
    const result = previewResult();
    const { largeValues } = mountLargeValues("postgres", result);
    const controller = new AbortController();
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("ID = 1");
    mocks.buildTableSelectSql.mockResolvedValue("select");
    let resolveRead!: (value: unknown) => void;
    let rejectRead!: (reason: Error) => void;
    mocks.executeMulti.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
    );
    const pending = largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }])(controller.signal);
    const outcome = pending.catch((error) => error);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledOnce());
    let finished = false;
    void outcome.then(() => {
      finished = true;
    });
    controller.abort();
    await nextTick();
    expect(finished).toBe(false);
    expect(mocks.cancelQuery).not.toHaveBeenCalled();
    if (completion === "resolve") resolveRead([{ columns: ["ID", "APP"], rows: [[1, "complete"]] }]);
    else rejectRead(new Error("transport lost"));
    expect(await outcome).toMatchObject({ status: completion === "resolve" ? "cancelled" : "unknown" });
  });

  it("keeps distinct quoted result names when resolving a captured legacy value", async () => {
    const result = previewResult();
    result.value.columns = ["ID", "id"];
    const { largeValues } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "id" FROM "APP_DATA"');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "id"], rows: [[1, "complete"]] }]);
    const resolved = await largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }])(new AbortController().signal);
    expect(resolved.get(1)?.get(1)).toBe("complete");
  });

  it.each(["duplicate_identity", "unknown_after_not_started"] as const)("rejects unsafe legacy export results (%s)", async (reason) => {
    const result = previewResult();
    const { largeValues } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("ID = 1");
    mocks.buildTableSelectSql.mockResolvedValue("select");
    const failed = { columns: ["message"], rows: [["failed"]], execution_error: true, error: { operationOutcome: "not_started" } };
    mocks.executeMulti.mockResolvedValue(
      reason === "duplicate_identity"
        ? [
            {
              columns: ["ID", "APP"],
              rows: [
                [1, "first"],
                [1, "second"],
              ],
            },
          ]
        : [failed, { ...failed, error: { operationOutcome: "unknown" } }],
    );
    await expect(largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }])(new AbortController().signal)).rejects.toMatchObject({ status: reason === "duplicate_identity" ? "failed" : "unknown" });
  });

  it("rejects a legacy export result that still contains a preview", async () => {
    const result = previewResult();
    const { largeValues } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("ID = 1");
    mocks.buildTableSelectSql.mockResolvedValue("select");
    mocks.executeMulti.mockResolvedValue([result.value]);
    await expect(largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }])(new AbortController().signal)).rejects.toMatchObject({ status: "failed" });
  });

  it("renders pending text without mutating data or automatically fetching a prefix, then decodes on explicit full read", async () => {
    vi.useFakeTimers();
    const result = previewResult("TEXT", "unvalidated carrier prefix", 20000);
    result.value.rows[0]![0] = "缤纷";
    result.value.raw_key_cells = [{ row_index: 0, column_index: 0, value: "çÍ·×" }];
    result.value.large_value_cells![0]!.pending_decode = true;
    const { largeValues, item } = mountLargeValues("mysql", result, false, { visible: true, legacy: true });
    expect(largeValues.formatGridItemCell(item(), 1)).toBe("grid.largeValuePendingDecode");
    expect(result.value.rows[0]![1]).toBe("unvalidated carrier prefix");
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("`ID` = 'çÍ·×'");
    mocks.buildTableSelectSql.mockResolvedValue("SELECT ID, APP FROM APP_DATA");
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [["缤纷", "完整文本"]], raw_key_cells: [{ row_index: 0, column_index: 0, value: "çÍ·×" }] }]);
    expect(await largeValues.hydrateLargeValueCell(1, 1)).toBe(true);
    expect(mocks.buildDataGridContextFilterCondition).toHaveBeenCalledWith(expect.objectContaining({ value: "çÍ·×" }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "MAXIMO", expect.any(String), undefined, "execution-1", expect.objectContaining({ resultKeyColumns: ["ID"] }));
    expect(result.value.large_value_cells).toEqual([]);
    expect(result.value.raw_key_cells).toEqual([{ row_index: 0, column_index: 0, value: "çÍ·×" }]);
    expect(largeValues.formatGridItemCell(item(), 1)).toBe("完整文本");
  });

  it("captures original charset keys for deferred exports after the grid result changes", async () => {
    const result = previewResult("TEXT", "prefix", 20000);
    result.value.rows[0]![0] = "缤纷";
    result.value.raw_key_cells = [{ row_index: 0, column_index: 0, value: "çÍ·×" }];
    result.value.large_value_cells![0]!.pending_decode = true;
    const { largeValues } = mountLargeValues("mysql", result, false, { legacy: true });
    const read = largeValues.captureSourceValues([{ rowId: 1, sourceIndex: 0, columnIndex: 1 }]);
    result.value.raw_key_cells[0]!.value = "changed";
    result.value = { ...result.value, rows: [["another", "new page"]] };
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("predicate");
    mocks.buildTableSelectSql.mockResolvedValue("SELECT ID, APP FROM APP_DATA");
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [["缤纷", "完整文本"]], raw_key_cells: [{ row_index: 0, column_index: 0, value: "çÍ·×" }] }]);
    const resolved = await read(new AbortController().signal);
    expect(mocks.buildDataGridContextFilterCondition).toHaveBeenCalledWith(expect.objectContaining({ value: "çÍ·×" }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("mysql-1", "MAXIMO", expect.any(String), undefined, "execution-1", expect.objectContaining({ resultKeyColumns: ["ID"] }));
    expect(resolved.get(1)?.get(1)).toBe("完整文本");
  });

  it("indexes captured original keys once per full export batch while matching reordered results", async () => {
    const rowCount = 200;
    let keyReads = 0;
    const rawKeyCells = Array.from({ length: rowCount }, (_, row_index) => ({
      row_index,
      column_index: 0,
      get value() {
        keyReads++;
        return `carrier-${row_index}`;
      },
    }));
    const context: LegacyLargeValueContext = {
      databaseType: "mysql",
      connectionId: "mysql-1",
      executionDatabase: "app",
      tableMeta: { tableName: "items", columns: [], primaryKeys: ["id"] },
      sourceColumns: ["id", "body"],
      rows: Array.from({ length: rowCount }, () => ["same decoded key", "prefix"]),
      rawKeyCells,
      requiresOriginalKeys: true,
      identifierQuote: "`",
      serverVersion: undefined,
      includeDatabaseName: true,
      includeRowId: false,
      timeoutSecs: 30,
    };
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("predicate");
    mocks.buildTableSelectSql.mockResolvedValue("SELECT id, body FROM items");
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["id", "body"],
        rows: Array.from({ length: rowCount }, (_, index) => ["same decoded key", `full-${rowCount - index - 1}`]),
        raw_key_cells: Array.from({ length: rowCount }, (_, row_index) => ({ row_index, column_index: 0, value: `carrier-${rowCount - row_index - 1}` })),
      },
    ]);
    const requests = Array.from({ length: rowCount }, (_, sourceIndex) => ({ rowId: sourceIndex + 1, sourceIndex, columnIndex: 1, originalBytes: 20000 }));
    const resolved: LegacyResolvedLargeValueCells = new Map();
    await fetchLegacyLargeValueRequestChunk(context, 1, requests, [0], resolved, { uuid: () => "export", translate: (key) => key, translateBackendError: String });
    expect(keyReads).toBe(rowCount);
    expect(mocks.buildDataGridContextFilterCondition).toHaveBeenCalledTimes(rowCount);
    for (let index = 0; index < rowCount; index++) expect(resolved.get(index + 1)?.get(1)).toBe(`full-${index}`);
  });

  it("matches composite original keys when different carriers have identical decoded display keys", async () => {
    const result = previewResult("TEXT", "prefix", 20000);
    result.value.columns = ["ID", "PART", "APP"];
    result.value.column_types = ["VARCHAR", "INT", "TEXT"];
    result.value.rows = [
      ["缤纷", 1, "prefix A"],
      ["缤纷", 1, "prefix B"],
    ];
    result.value.raw_key_cells = [
      { row_index: 0, column_index: 0, value: "çÍ·×" },
      { row_index: 0, column_index: 1, value: 1 },
      { row_index: 1, column_index: 0, value: "缤纷" },
      { row_index: 1, column_index: 1, value: 1 },
    ];
    result.value.large_value_cells = [0, 1].map((row_index) => ({ row_index, column_index: 2, original_bytes: 20000, pending_decode: true }));
    const { largeValues } = mountLargeValues("mysql", result, false, { primaryKeys: ["ID", "PART"], legacy: true });
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("predicate");
    mocks.buildTableSelectSql.mockResolvedValue("SELECT ID, PART, APP FROM APP_DATA");
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["ID", "PART", "APP"],
        rows: [
          ["缤纷", 1, "full B"],
          ["缤纷", 1, "full A"],
        ],
        raw_key_cells: result.value.raw_key_cells.map((cell) => ({ ...cell, row_index: 1 - cell.row_index })),
      },
    ]);
    const resolved = await largeValues.resolveLargeValueCells([1, 2], [2]);
    expect(resolved.get(1)?.get(2)).toBe("full A");
    expect(resolved.get(2)?.get(2)).toBe("full B");
    expect(result.value.rows.map((row) => row[2])).toEqual(["prefix A", "prefix B"]);
    expect(mocks.buildDataGridContextFilterCondition.mock.calls.map(([request]) => request.value)).toEqual(["çÍ·×", 1, "缤纷", 1]);
  });

  it("rejects ambiguous projected key columns instead of picking the first display column", async () => {
    const result = previewResult("TEXT", "prefix", 20000);
    result.value.columns.push("ID");
    result.value.rows[0]!.push(2);
    result.value.raw_key_cells = [
      { row_index: 0, column_index: 0, value: 1 },
      { row_index: 0, column_index: 2, value: 2 },
    ];
    result.value.large_value_cells![0]!.pending_decode = true;
    const { largeValues } = mountLargeValues("mysql", result, false, { legacy: true });
    expect(await largeValues.hydrateLargeValueCell(1, 1)).toBe(false);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(result.value.rows[0]![1]).toBe("prefix");
  });

  it.each(["missing source", "duplicate source", "missing response", "duplicate response", "pending response"])("rejects %s metadata without publishing a guessed value", async (scenario) => {
    const result = previewResult("TEXT", "prefix", 20000);
    result.value.large_value_cells![0]!.pending_decode = true;
    result.value.raw_key_cells = scenario === "missing source" ? [] : [{ row_index: 0, column_index: 0, value: 1 }];
    if (scenario === "duplicate source") result.value.raw_key_cells.push({ row_index: 0, column_index: 0, value: 2 });
    const { largeValues } = mountLargeValues("mysql", result, false, { legacy: true });
    mocks.buildDataGridContextFilterCondition.mockResolvedValue("predicate");
    mocks.buildTableSelectSql.mockResolvedValue("SELECT ID, APP FROM APP_DATA");
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["ID", "APP"],
        rows:
          scenario === "duplicate response"
            ? [
                [1, "first"],
                [1, "second"],
              ]
            : [[1, "full"]],
        raw_key_cells:
          scenario === "missing response"
            ? []
            : scenario === "duplicate response"
              ? [
                  { row_index: 0, column_index: 0, value: 1 },
                  { row_index: 1, column_index: 0, value: 1 },
                ]
              : [{ row_index: 0, column_index: 0, value: 1 }],
        large_value_cells: scenario === "pending response" ? [{ row_index: 0, column_index: 1, original_bytes: 20000, pending_decode: true }] : [],
      },
    ]);
    expect(await largeValues.hydrateLargeValueCell(1, 1)).toBe(false);
    expect(result.value.rows[0]![1]).toBe("prefix");
    expect(result.value.large_value_cells![0]!.pending_decode).toBe(true);
    if (scenario.endsWith("source")) expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it.each(["result", "locator", "clientSessionId", "txnSessionId", "catalog", "disposal"] as const)("rejects a captured download target after its %s changes", async (change) => {
    const result = previewResult("CLOB", "preview", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO", clientSessionId: "original-session" };
    result.value.large_value_cells![0]!.value_ref = "original-locator";
    const { largeValues, runtimeScope } = mountLargeValues("oceanbase-oracle", result);
    const target = largeValues.captureSnapshotDownloadTarget(1, 1)!;
    expect(largeValues.isSnapshotDownloadTargetCurrent(target)).toBe(true);
    if (change === "result") result.value = { ...result.value, rows: [[2, "new preview"]] };
    else if (change === "locator") result.value.large_value_cells![0]!.value_ref = "replacement-locator";
    else if (change === "disposal") runtimeScope.dispose();
    else result.value.large_value_context![change] = "replacement-context";
    expect(largeValues.isSnapshotDownloadTargetCurrent(target)).toBe(false);
    await expect(largeValues.downloadSnapshotTarget(target, "lob.txt")).rejects.toThrow("context changed");
    expect(mocks.downloadLargeValue).not.toHaveBeenCalled();
    expect(target.context.clientSessionId).toBe("original-session");
    expect(target.valueRef).toBe("original-locator");
  });

  it.each([undefined, "binary", "utf8", "gbk"] as const)("downloads a captured original target with %s encoding", async (encoding) => {
    const result = previewResult("BLOB", "0x11", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO", txnSessionId: "original-transaction" };
    result.value.large_value_cells![0]!.value_ref = "original-locator";
    const { largeValues } = mountLargeValues("oceanbase-oracle", result);
    mocks.downloadLargeValue.mockResolvedValue(undefined);
    const target = largeValues.captureSnapshotDownloadTarget(1, 1)!;
    await largeValues.downloadSnapshotTarget(target, "lob.bin", encoding);
    expect(mocks.downloadLargeValue).toHaveBeenCalledWith(expect.objectContaining({ valueRef: "original-locator", txnSessionId: "original-transaction", downloadEncoding: encoding }), "lob.bin", target.signal);
  });

  it("cancels a captured target's pending download on cleanup", async () => {
    const result = previewResult("CLOB", "preview", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "original-locator";
    const { largeValues, runtimeScope } = mountLargeValues("oceanbase-oracle", result);
    mocks.downloadLargeValue.mockImplementation(() => new Promise(() => {}));
    mocks.cancelQuery.mockRejectedValue(new Error("cancel failed"));
    const target = largeValues.captureSnapshotDownloadTarget(1, 1)!;
    const pending = largeValues.downloadSnapshotTarget(target, "lob.txt");
    runtimeScope.dispose();
    await expect(pending).rejects.toThrow("cancelled locally");
    expect(target.signal.aborted).toBe(true);
    expect(mocks.cancelQuery).toHaveBeenCalledWith("execution-1");
  });

  it("retains a hydrated locator for release even when the result has no ref array", async () => {
    const result = previewResult("CLOB", "preview", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "old-page-locator";
    mocks.readLargeValueChunk.mockResolvedValue({ status: "ok", data: "complete", next_offset: 8, eof: true, value_kind: "text" });
    const { largeValues } = mountLargeValues("oceanbase-oracle", result);
    expect(await largeValues.hydrateLargeValueCell(1, 1)).toBe(true);
    expect(result.value.large_value_cells).toEqual([]);
    expect(result.value.large_value_refs).toContain("old-page-locator");
  });

  it.each(["read", "download", "save baseline"] as const)("ends a stalled %s on grid cleanup without accepting late success", async (operation) => {
    const result = previewResult("CLOB", "original preview", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "old-locator";
    let release!: (value: unknown) => void;
    const external = new Promise((resolve) => {
      release = resolve;
    });
    mocks.readLargeValueChunk.mockReturnValueOnce(external);
    mocks.downloadLargeValue.mockReturnValueOnce(external);
    mocks.cancelQuery.mockRejectedValue(new Error("cancel failed"));
    const { largeValues, runtimeScope } = mountLargeValues("oceanbase-oracle", result);
    const work = operation === "read" ? largeValues.resolveLargeValueCells([1], [1]) : operation === "download" ? largeValues.downloadSnapshotCell(1, 1, "lob.txt") : largeValues.prepareSaveBaseline({ dirtyRows: new Map([[0, new Map([[1, "edit"]])]]), deletedRows: new Set() });
    let outcome: unknown;
    const settled = work.then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );
    runtimeScope.dispose();
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(Error), { timeout: 150 });
    await settled;
    release({ status: "ok", data: "late", next_offset: 4, eof: true, value_kind: "text" });
    await nextTick();
    expect(result.value.rows[0]![1]).toBe("original preview");
    expect(result.value.large_value_cells![0]!.value_ref).toBe("old-locator");
  });
  it("ends a stalled snapshot read locally when its result changes even if server cancellation fails", async () => {
    const result = previewResult("CLOB", "original preview", 5000);
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "old-locator";
    const oldResult = result.value;
    let release!: (chunk: unknown) => void;
    mocks.readLargeValueChunk.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    mocks.cancelQuery.mockRejectedValue(new Error("cancel failed"));
    const { largeValues } = mountLargeValues("oceanbase-oracle", result);
    let outcome: unknown;
    const pending = largeValues.resolveLargeValueCells([1], [1]).then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );
    await nextTick();
    result.value = { ...oldResult, rows: [[1, "new preview"]] };
    await nextTick();
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(Error), { timeout: 150 });
    await pending;
    release({ status: "ok", data: "late", next_offset: 4, eof: true, value_kind: "text" });
    await nextTick();
    expect(oldResult.rows[0]![1]).toBe("original preview");
    expect(result.value.rows[0]![1]).toBe("new preview");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it.each(["CLOB", "BLOB"])("keeps the first pending %s edit when loading a second complete LOB on the same row", async (columnType) => {
    const binary = columnType === "BLOB";
    const firstEdit = binary ? "0x00ff80" : "first pending edit";
    const secondEdit = binary ? "0xaabbcc" : "second pending edit";
    const firstData = (binary ? "11" : "a").repeat(2057);
    const secondData = (binary ? "22" : "b").repeat(2061);
    const result = previewResult(columnType, binary ? "0x11" : "first preview", 2057);
    result.value.columns.push("DOCUMENT");
    result.value.column_types!.push(columnType);
    result.value.rows[0]!.push(binary ? "0x22" : "second preview");
    result.value.large_value_context = { connectionId: "oceanbase-oracle-1", database: "MAXIMO" };
    result.value.large_value_cells = [
      { row_index: 0, column_index: 1, original_bytes: 2057, value_ref: "first" },
      { row_index: 0, column_index: 2, original_bytes: 2061, value_ref: "second" },
    ];
    mocks.readLargeValueChunk.mockImplementation(async (options) => {
      const bytes = options.valueRef === "first" ? 2057 : 2061;
      return { status: "ok", data: options.valueRef === "first" ? firstData : secondData, next_offset: bytes, eof: true, value_kind: binary ? "binary" : "text" };
    });
    const { largeValues, editor } = mountLargeValues("oceanbase-oracle", result, true);
    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);
    editor!.applyCellValue(0, 1, firstEdit);
    await nextTick();
    const row = result.value.rows[0];
    await expect(largeValues.hydrateLargeValueCell(1, 2)).resolves.toBe(true);
    await nextTick();
    expect(editor!.dirtyRows.value.get(0)?.get(1)).toBe(firstEdit);
    expect(result.value.rows[0]).toBe(row);
    editor!.applyCellValue(0, 2, secondEdit);
    mocks.prepareDataGridSave.mockResolvedValue({ statements: [`both ${columnType} updates`], rollbackStatements: [] });
    await editor!.previewChanges();
    expect(mocks.prepareDataGridSave.mock.calls[0]![0].dirtyRows).toEqual([
      [
        0,
        [
          [1, firstEdit],
          [2, secondEdit],
        ],
      ],
    ]);
    expect(result.value.rows[0]).toEqual([1, (binary ? "0x" : "") + firstData, (binary ? "0x" : "") + secondData]);
    editor!.undoPendingChange();
    expect(editor!.dirtyRows.value.get(0)?.get(1)).toBe(firstEdit);
    expect(editor!.dirtyRows.value.get(0)?.has(2)).toBe(false);
  });

  it.each([
    ["CLOB", "preview"],
    ["CLOB", "failed preparation"],
    ["BLOB", "preview"],
    ["BLOB", "failed preparation"],
  ])("keeps editor edits, deletes and undo after %s baseline reads during %s", async (columnType, action) => {
    const binary = columnType === "BLOB";
    const result = previewResult(columnType, binary ? "0x00" : "preview", 1);
    result.value.rows.push([2, "second preview"]);
    result.value.large_value_context = { connectionId: "oracle-1", database: "MAXIMO" };
    result.value.large_value_cells = [
      { row_index: 0, column_index: 1, original_bytes: 1, value_ref: "first" },
      { row_index: 1, column_index: 1, original_bytes: 1, value_ref: "second" },
    ];
    const { editor } = mountLargeValues("oracle", result, true);
    editor!.newRows.value = [[3, "pending insert"]];
    editor!.applyCellValue(0, 1, "pending edit");
    editor!.applyDeleteRow(1);
    const rows = result.value.rows;
    const first = rows[0];
    const second = rows[1];
    mocks.readLargeValueChunk.mockResolvedValue({ status: "ok", data: binary ? "00ff" : "complete", next_offset: binary ? 2 : 8, eof: true, value_kind: binary ? "binary" : "text" });
    if (action === "preview") {
      mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE APP_DATA", "DELETE APP_DATA"], rollbackStatements: [] });
      await editor!.previewChanges();
    } else {
      mocks.prepareDataGridSave.mockRejectedValue(new Error("preparation failed"));
      await editor!.saveChanges();
    }
    await nextTick();
    expect(editor!.dirtyRows.value.get(0)?.get(1)).toBe("pending edit");
    expect(editor!.deletedRows.value.has(1)).toBe(true);
    expect(editor!.newRows.value).toEqual([[3, "pending insert"]]);
    expect(editor!.hasPendingChanges.value).toBe(true);
    expect(editor!.canUndoPendingChange.value).toBe(true);
    expect(result.value.rows).toBe(rows);
    expect(result.value.rows[0]).toBe(first);
    expect(result.value.rows[1]).toBe(second);
    expect(first![1]).toBe(binary ? "0x00ff" : "complete");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    editor!.undoPendingChange();
    expect(editor!.deletedRows.value.has(1)).toBe(false);
    expect(editor!.dirtyRows.value.get(0)?.get(1)).toBe("pending edit");
  });
  it("loads original LOB baselines before clear/delete SQL generation without replacing pending edits", async () => {
    const result = previewResult("CLOB", "preview", 1);
    result.value.large_value_context = { connectionId: "oracle-1", database: "MAXIMO", clientSessionId: "original-session" };
    result.value.large_value_cells![0]!.value_ref = "original-locator";
    const { largeValues } = mountLargeValues("oracle", result);
    const dirtyRows = new Map([[0, new Map([[1, null]])]]);
    mocks.readLargeValueChunk.mockResolvedValue({ status: "ok", data: "original complete", next_offset: 17, eof: true, value_kind: "text" });
    await largeValues.prepareSaveBaseline({ dirtyRows, deletedRows: new Set() });
    expect(result.value.rows[0]![1]).toBe("original complete");
    expect(dirtyRows.get(0)!.get(1)).toBeNull();
    expect(result.value.large_value_refs).toContain("original-locator");
    expect(result.value.large_value_cells).toEqual([]);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.readLargeValueChunk).toHaveBeenCalledWith(expect.objectContaining({ valueRef: "original-locator", connectionId: "oracle-1", clientSessionId: "original-session" }));
  });

  it("loads full PostgreSQL preview values before clear SQL generation so rollback keeps the original", async () => {
    const full = JSON.stringify(Array.from({ length: 50 }, (_, n) => ({ date: "2026-10-15", n })));
    const result = previewResult("json", `${full.slice(0, 18)}...`, full.length);
    const { largeValues } = mountLargeValues("postgres", result);
    const first = result.value.rows[0];
    const dirtyRows = new Map([[0, new Map([[1, null]])]]);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "public"."APP_DATA" WHERE ("ID" = 1) LIMIT 1');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [[1, full]], affected_rows: 0, execution_time_ms: 1 }]);

    await largeValues.prepareSaveBaseline({ dirtyRows, deletedRows: new Set() });

    expect(result.value.rows[0]).toBe(first);
    expect(result.value.rows[0]![1]).toBe(full);
    expect(dirtyRows.get(0)!.get(1)).toBeNull();
    expect(result.value.large_value_cells).toEqual([]);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.not.objectContaining({ largeValuePreviewSize: expect.anything() }));
    expect(mocks.readLargeValueChunk).not.toHaveBeenCalled();
  });

  it("loads every PostgreSQL preview of a deleted row and leaves untouched previews alone", async () => {
    const result = previewResult("jsonb", "[1, 2...", 4096);
    result.value.columns.push("DOC");
    result.value.column_types!.push("json");
    result.value.rows[0]!.push('{"a"...');
    result.value.rows.push([2, "[3, 4...", '{"b"...']);
    result.value.large_value_cells = [
      { row_index: 0, column_index: 1, original_bytes: 4096 },
      { row_index: 0, column_index: 2, original_bytes: 4096 },
      { row_index: 1, column_index: 1, original_bytes: 4096 },
      { row_index: 1, column_index: 2, original_bytes: 4096 },
    ];
    const { largeValues } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "public"."APP_DATA" WHERE ("ID" = 1) LIMIT 1');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP", "DOC"], rows: [[1, "[1, 2, 3]", '{"a": 1}']], affected_rows: 0, execution_time_ms: 1 }]);

    await largeValues.prepareSaveBaseline({ dirtyRows: new Map(), deletedRows: new Set([0]) });

    expect(result.value.rows[0]).toEqual([1, "[1, 2, 3]", '{"a": 1}']);
    expect(result.value.rows[1]).toEqual([2, "[3, 4...", '{"b"...']);
    expect(result.value.large_value_cells).toEqual([
      { row_index: 1, column_index: 1, original_bytes: 4096 },
      { row_index: 1, column_index: 2, original_bytes: 4096 },
    ]);
  });

  it("blocks save and keeps the PostgreSQL preview when its full value cannot be loaded", async () => {
    const result = previewResult("json", '{"date":"2026-10-1...', 4096);
    const { largeValues } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "public"."APP_DATA" WHERE ("ID" = 1) LIMIT 1');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [], affected_rows: 0, execution_time_ms: 1 }]);

    await expect(largeValues.prepareSaveBaseline({ dirtyRows: new Map([[0, new Map([[1, null]])]]), deletedRows: new Set() })).rejects.toThrow("grid.largeValueRowUnavailable");

    expect(result.value.rows[0]).toEqual([1, '{"date":"2026-10-1...']);
    expect(result.value.large_value_cells).toHaveLength(1);
  });

  it("blocks save on expired snapshots and keeps every original preview for retry", async () => {
    const result = previewResult("CLOB", "preview", 1);
    result.value.large_value_context = { connectionId: "oracle-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "expired-locator";
    const { largeValues } = mountLargeValues("oracle", result);
    const originalRows = result.value.rows;
    mocks.readLargeValueChunk.mockResolvedValue({ status: "expired" });
    await expect(largeValues.prepareSaveBaseline({ dirtyRows: new Map(), deletedRows: new Set([0]) })).rejects.toThrow("snapshot expired");
    expect(result.value.rows).toBe(originalRows);
    expect(result.value.large_value_cells![0]!.value_ref).toBe("expired-locator");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("refuses a save baseline owned by another connection even after hydration", async () => {
    const result = previewResult("CLOB", "complete original", 1);
    result.value.large_value_cells = [];
    result.value.large_value_context = { connectionId: "different-connection", database: "MAXIMO" };
    result.value.large_value_refs = ["retained-original-locator"];
    const { largeValues } = mountLargeValues("oracle", result);
    await expect(largeValues.prepareSaveBaseline({ dirtyRows: new Map([[0, new Map([[1, null]])]]), deletedRows: new Set() })).rejects.toThrow("connection is unavailable");
    expect(mocks.readLargeValueChunk).not.toHaveBeenCalled();
  });

  it("preserves a concurrently hydrated cell when save baseline preparation finishes later", async () => {
    const result = previewResult("CLOB", "first preview", 1);
    result.value.columns.push("DOCUMENT");
    result.value.column_types!.push("CLOB");
    result.value.rows[0]!.push("second preview");
    result.value.large_value_context = { connectionId: "oracle-1", database: "MAXIMO" };
    result.value.large_value_cells = [
      { row_index: 0, column_index: 1, original_bytes: 1, value_ref: "first-locator" },
      { row_index: 0, column_index: 2, original_bytes: 1, value_ref: "second-locator" },
    ];
    result.value.large_value_refs = ["first-locator", "second-locator"];
    let finishFirst!: (chunk: unknown) => void;
    mocks.readLargeValueChunk.mockImplementation(({ valueRef }) =>
      valueRef === "first-locator"
        ? new Promise((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve({ status: "ok", data: "second complete", next_offset: 15, eof: true, value_kind: "text" }),
    );
    const { largeValues } = mountLargeValues("oracle", result);
    const preparation = largeValues.prepareSaveBaseline({ dirtyRows: new Map([[0, new Map([[1, null]])]]), deletedRows: new Set() });
    await expect(largeValues.hydrateLargeValueCell(1, 2)).resolves.toBe(true);
    finishFirst({ status: "ok", data: "first complete", next_offset: 14, eof: true, value_kind: "text" });
    await preparation;
    expect(result.value.rows[0]).toEqual([1, "first complete", "second complete"]);
    expect(result.value.large_value_cells).toEqual([]);
  });
  it("hydrates every large value cell on the current page in one batch", async () => {
    const result = previewResult("text", "preview", 9);
    result.value.large_value_context = { connectionId: "postgres-1", database: "MAXIMO" };
    result.value.large_value_cells![0]!.value_ref = "page-locator";
    mocks.readLargeValueChunk.mockResolvedValue({ status: "ok", data: "full text", next_offset: 9, eof: true, value_kind: "text" });
    const { largeValues } = mountLargeValues("postgres", result);

    await expect(largeValues.hydrateLargeValueCells([1], [0, 1])).resolves.toBe(1);

    expect(result.value.rows[0]).toEqual([1, "full text"]);
    expect(result.value.large_value_cells).toEqual([]);
    expect(result.value.large_value_refs).toContain("page-locator");
  });
  it.each([
    ["postgres", 3],
    ["mysql", 1],
  ] as const)("preserves %s fetch batching when a small binary column shares a row with another large value", async (databaseType, expectedBatches) => {
    const result = previewResult("bytea", "0x00...", 8193);
    result.value.columns.push("DOCUMENT");
    result.value.column_types!.push("text");
    result.value.rows = [1, 2, 3].map((id) => [id, "0x00...", "large document..."]);
    result.value.large_value_cells = [0, 1, 2].flatMap((row_index) => [
      { row_index, column_index: 1, original_bytes: 8193 },
      { row_index, column_index: 2, original_bytes: 64 * 1024 * 1024 },
    ]);
    const { largeValues } = mountLargeValues(databaseType, result);
    mocks.buildDataGridContextFilterCondition.mockImplementation(({ value }) => Promise.resolve(`"ID" = ${value}`));
    mocks.buildTableSelectSql.mockImplementation((options) => Promise.resolve(JSON.stringify(options)));
    mocks.executeMulti.mockImplementation(async (_connection, _database, sql) => {
      const options = JSON.parse(sql);
      const ids = [...options.whereInput.matchAll(/"ID" = (\d+)/g)].map((match) => Number(match[1]));
      return [{ columns: ["ID", "APP", "DOCUMENT"], rows: ids.map((id) => [id, "0x00", "full document"]), affected_rows: 0, execution_time_ms: 1 }];
    });

    const resolved = await largeValues.resolveLargeValueCells([1, 2, 3], [1]);

    expect([...resolved.keys()]).toEqual([1, 2, 3]);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(expectedBatches);
    expect(mocks.buildTableSelectSql.mock.calls.every(([options]) => options.limit === 3 / expectedBatches)).toBe(true);
  });

  it.each(["0x", "0X", "\\x"])("shows the full bytea size and downloads all bytes after hydrating a %s preview", async (prefix) => {
    const bytes = Uint8Array.from({ length: 9645 }, (_, index) => index % 256);
    const hex = Buffer.from(bytes).toString("hex");
    const result = previewResult("bytea", `${prefix}${hex.slice(0, 3276 * 2)}...`, bytes.length);
    const { largeValues, toast, item } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "public"."APP_DATA" WHERE "ID" = 1 LIMIT 1');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [[1, `${prefix}${hex}`]], affected_rows: 0, execution_time_ms: 1 }]);

    expect(largeValues.formatGridItemCell(item(), 1)).toBe("BYTEA [9.4 KB]");
    expect(() => binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres")).toThrow();
    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);

    const selectOptions = mocks.buildTableSelectSql.mock.calls[0]![0];
    expect(selectOptions).toMatchObject({ databaseType: "postgres", columns: ["ID", "APP"], primaryKeys: ["ID"], limit: 1 });
    expect(selectOptions).not.toHaveProperty("largeValuePreviewSize");
    expect(result.value.large_value_cells).toEqual([]);
    expect(largeValues.formatGridItemCell(item(), 1)).toBe("BYTEA [9.4 KB]");
    expect(binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres").data).toEqual(bytes);
    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("retains an incomplete bytea preview when the full value cannot be fetched", async () => {
    const result = previewResult();
    const { largeValues, toast, item } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "APP_DATA" WHERE "ID" = 1');
    mocks.executeMulti.mockRejectedValue(new Error("connection lost"));

    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(false);

    expect(largeValues.isLargeValuePreview(item(), 1)).toBe(true);
    expect(result.value.rows[0]![1]).toBe("\\x00017f80ff...");
    expect(() => binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres")).toThrow();
    expect(toast).toHaveBeenCalledWith("grid.largeValueLoadFailedWithMessage", 5000);
  });

  it.each([
    ["postgres", " BYTEA ", 64 * 1024 * 1024],
    ["postgres", "text", undefined],
    ["postgres", "bytea[]", undefined],
    ["db2", "BLOB", undefined],
    ["mysql", "LONGBLOB", 64 * 1024 * 1024],
  ] as const)("uses only known original sizes for %s %s", (databaseType, columnType, expected) => {
    const result = previewResult(columnType, "0x00...", 64 * 1024 * 1024);
    const { largeValues, item } = mountLargeValues(databaseType, result);
    expect(largeValues.largeValueOriginalBytes(item(), 1)).toBe(expected);
    expect(largeValues.largeValueOriginalBytes({ ...item(), isDirtyCol: [false, true] }, 1)).toBeUndefined();
    expect(largeValues.largeValueOriginalBytes({ ...item(), isNew: true }, 1)).toBeUndefined();
  });

  it("hydrates a deferred DB2 BLOB through its primary key", async () => {
    const result = ref<QueryResult>({
      columns: ["ID", "APP"],
      column_types: ["BIGINT", "BLOB"],
      rows: [[1, "<BLOB>"]],
      affected_rows: 0,
      execution_time_ms: 1,
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }],
    });
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "APP_DATA" WHERE "ID" = 1 FETCH FIRST 1 ROWS ONLY');
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["ID", "APP"],
        rows: [[1, "0x0102"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { largeValues, toast } = mountLargeValues("db2", result);

    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "db2", columns: ["ID", "APP"], primaryKeys: ["ID"] }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("db2-1", "MAXIMO", expect.any(String), undefined, "execution-1", {
      maxRows: 1,
      fetchSize: 1,
      timeoutSecs: 60,
    });
    expect(result.value.rows).toEqual([[1, "0x0102"]]);
    expect(result.value.large_value_cells).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});
