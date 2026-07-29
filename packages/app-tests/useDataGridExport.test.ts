import { strict as assert } from "node:assert";
import { computed, ref } from "vue";
import { beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import type { DataGridTableMeta } from "../../apps/desktop/src/lib/dataGrid/dataGridSql.ts";
import type { DatabaseType, QueryResult } from "../../apps/desktop/src/types/database.ts";

const apiMock = vi.hoisted(() => ({
  startQueryResultExport: vi.fn(),
  cancelQueryResultExport: vi.fn(),
  startTableExport: vi.fn(),
  cancelTableExport: vi.fn(),
  saveEditorSettings: vi.fn(async () => {}),
  exportQueryResultCsv: vi.fn(),
  exportQueryResultXlsx: vi.fn(),
  exportQueryResultJson: vi.fn(),
  exportQueryResultMarkdown: vi.fn(),
  exportQueryResultsXlsx: vi.fn(),
  buildDataGridCopyInsertStatement: vi.fn(),
  buildExportSqlInsert: vi.fn(),
}));
const clipboardMock = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
}));
const runtimeMock = vi.hoisted(() => ({ isTauri: false }));
const dialogMock = vi.hoisted(() => ({ save: vi.fn() }));
const toastMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() =>
  vi.fn((key: string, params?: Record<string, unknown>) => {
    if (key === "exportProgress.xlsxRowLimit") return `XLSX 最多支持 ${params?.limit} 行数据，请使用 CSV 导出完整结果。`;
    if (key === "grid.exportFailed") return `导出失败：${params?.message}`;
    return key;
  }),
);

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/lib/common/clipboard", () => clipboardMock);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtimeMock.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialogMock.save }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("vue-i18n", () => ({
  createI18n: () => ({
    global: {
      locale: { value: "en" },
      setLocaleMessage: vi.fn(),
    },
    install: vi.fn(),
  }),
  useI18n: () => ({ t: translateMock }),
}));

const { defaultDataGridExportFileName, useDataGridExport } = await import("../../apps/desktop/src/composables/useDataGridExport.ts");

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function installTextDownloadCapture() {
  let downloadedBlob: Blob | undefined;
  const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob;
    return "blob:test-export";
  });
  const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ click: vi.fn(), href: "", download: "" }) },
  });
  return {
    content: async () => downloadedBlob?.text(),
    restore: () => {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

function buildExportHarness(
  options: {
    currentResultLabel?: string;
    exportFileBaseName?: string;
    columns?: string[];
    columnTypes?: Array<string | undefined>;
    allColumnTypes?: Array<string | undefined>;
    rows?: QueryResult["rows"];
    allExportResults?: Array<{ sheetName: string; result: QueryResult; sql?: string }>;
    completeLocalResult?: QueryResult;
    tableMeta?: DataGridTableMeta;
    sourceColumns?: Array<string | undefined>;
    databaseType?: DatabaseType;
    context?: "results" | "table-data";
  } = {},
) {
  const exportColumns = options.columns ?? ["id", "name"];
  const exportRows = options.rows ?? [
    [1, "Ada"],
    [2, "Lin"],
  ];
  const rowItems = exportRows.map((data, index) => ({ id: index + 1, data, isNew: false, isDeleted: false, isDirtyCol: data.map(() => false), status: "" }));
  const exportProgressDialog = ref(false);
  const exportProgressState = ref({
    title: "",
    tableName: "",
    format: "csv",
    rowsExported: 0,
    totalRows: null as number | null,
    status: "",
    errorMessage: null as string | null,
    filePath: null as string | null,
  });
  const exportCancelHandler = ref<(() => Promise<void>) | null>(null);
  const fullExportResult = vi.fn(async () => {
    throw new Error("fullExportResult should not be called for streaming CSV/XLSX query exports");
  });
  const queryResultExportRequest = vi.fn(async (options: { exportId: string; filePath: string; format: "csv" | "xlsx" | "txt" | "sql"; includeSqlSheet?: boolean; exportTableName?: string; exportColumnTypes?: Array<string | null | undefined> }) => ({
    exportId: options.exportId,
    connectionId: "conn-1",
    database: "db",
    schema: "public",
    sql: "SELECT * FROM users",
    queryBaseSql: "SELECT * FROM users",
    databaseType: "postgres" as const,
    useAgentCursor: false,
    filePath: options.filePath,
    format: options.format,
    includeSqlSheet: options.includeSqlSheet,
    exportTableName: options.exportTableName,
    exportColumnTypes: options.exportColumnTypes,
    pageSize: 1000,
    rowLimit: 100000,
    totalRows: 2,
    timeoutSecs: 30,
    keysetOptimizationEnabled: true,
    clientSessionId: "tab-1:export",
    executionId: "exec-1",
  }));

  const composable = useDataGridExport({
    columns: computed(() => exportColumns),
    displayItems: computed(() => rowItems),
    sql: computed(() => "SELECT * FROM users"),
    exportSql: computed(() => "SELECT * FROM users ORDER BY id DESC"),
    tableMeta: computed(() => options.tableMeta),
    databaseType: computed(() => options.databaseType ?? "postgres"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "db"),
    context: computed(() => options.context ?? "results"),
    sourceColumns: computed(() => options.sourceColumns),
    columnTypes: computed(() => options.columnTypes),
    allColumnTypes: computed(() => options.allColumnTypes),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell: ref(null),
    getRowItem: (rowId: number) => rowItems.find((item) => item.id === rowId),
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
    fullExportResult,
    queryResultExportRequest,
    hasCompleteLocalResult: computed(() => !!options.completeLocalResult),
    completeLocalResult: computed(() => options.completeLocalResult),
    allExportResults: computed(() => options.allExportResults),
    currentResultLabel: computed(() => options.currentResultLabel),
    exportFileBaseName: computed(() => options.exportFileBaseName),
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
  });

  return {
    composable,
    fullExportResult,
    queryResultExportRequest,
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
  };
}

function buildTableDataExportHarness() {
  const exportProgressDialog = ref(false);
  const exportProgressState = ref({
    title: "",
    tableName: "",
    format: "csv",
    rowsExported: 0,
    totalRows: null as number | null,
    status: "",
    errorMessage: null as string | null,
    filePath: null as string | null,
  });
  const exportCancelHandler = ref<(() => Promise<void>) | null>(null);

  const composable = useDataGridExport({
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => [
      { id: 1, data: [1, "Ada"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
      { id: 2, data: [2, "Lin"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
    ]),
    sql: computed(() => undefined),
    tableMeta: computed(() => ({
      schema: "public",
      tableName: "users",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    })),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "db"),
    context: computed(() => "table-data"),
    sourceColumns: computed(() => undefined),
    columnTypes: computed(() => ["integer", "text"]),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell: ref(null),
    getRowItem: () => undefined,
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
  });

  return {
    composable,
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  runtimeMock.isTauri = false;
  dialogMock.save.mockResolvedValue(null);
  clipboardMock.copyToClipboard.mockResolvedValue(undefined);
  apiMock.startQueryResultExport.mockImplementation(async (_request, onProgress) => {
    onProgress({ exportId: _request.exportId, tableName: "", rowsExported: 2, totalRows: 2, status: "Done" });
    return { exportId: _request.exportId, tableName: "", rowsExported: 2, totalRows: 2, status: "Done" };
  });
  apiMock.startTableExport.mockImplementation(async (_request, onProgress) => {
    onProgress({ exportId: _request.exportId, tableName: _request.tableName, rowsExported: 2, totalRows: 2, status: "Done" });
    return { exportId: _request.exportId, tableName: _request.tableName, rowsExported: 2, totalRows: 2, status: "Done" };
  });
});

test("copy row JSON expands nested JSON strings", async () => {
  const contextCell = ref({ rowId: 1, rowIndex: 0, col: 0 });
  const jsonString = '{"endingBalance":{"beginningBalance":"0","endingBalance":"20000","endingDate":"2024-10-30"},"financeChargeInfo":null,"interestChargeInfo":null,"Line":[]}';
  const row = {
    id: 1,
    data: ["67218700e884ae1f527640b6", jsonString, "draft"],
    isNew: false,
    isDeleted: false,
    isDirtyCol: [false, false, false],
    status: "",
  };
  const composable = useDataGridExport({
    columns: computed(() => ["_id", "data", "status"]),
    displayItems: computed(() => [row]),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    databaseType: computed(() => "mongodb"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "db"),
    context: computed(() => "results"),
    sourceColumns: computed(() => undefined),
    columnTypes: computed(() => undefined),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell,
    getRowItem: () => row,
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
  });

  await composable.copyRow();

  assert.equal(clipboardMock.copyToClipboard.mock.calls.length, 1);
  assert.deepEqual(JSON.parse(clipboardMock.copyToClipboard.mock.calls[0][0]), {
    _id: "67218700e884ae1f527640b6",
    data: {
      endingBalance: {
        beginningBalance: "0",
        endingBalance: "20000",
        endingDate: "2024-10-30",
      },
      financeChargeInfo: null,
      interestChargeInfo: null,
      Line: [],
    },
    status: "draft",
  });
});

test("copy row JSON keeps nested JSON strings for non-MongoDB rows", async () => {
  const contextCell = ref({ rowId: 1, rowIndex: 0, col: 0 });
  const jsonString = '{"enabled":true}';
  const row = {
    id: 1,
    data: [1, jsonString],
    isNew: false,
    isDeleted: false,
    isDirtyCol: [false, false],
    status: "",
  };
  const composable = useDataGridExport({
    columns: computed(() => ["id", "payload"]),
    displayItems: computed(() => [row]),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "db"),
    context: computed(() => "table"),
    sourceColumns: computed(() => undefined),
    columnTypes: computed(() => undefined),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell,
    getRowItem: () => row,
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
  });

  await composable.copyRow();

  assert.deepEqual(JSON.parse(clipboardMock.copyToClipboard.mock.calls[0][0]), {
    id: 1,
    payload: jsonString,
  });
});

test("default data grid export file names use sanitized base names and compact local timestamps", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    assert.equal(defaultDataGridExportFileName("daily/report.sql", "export", "csv"), "daily_report_260602150405.csv");
    assert.equal(defaultDataGridExportFileName("daily/report.sql", "export", "xlsx", { page: true }), "daily_report_page_260602150405.xlsx");
    assert.equal(defaultDataGridExportFileName("  .sql  ", "query-result", "csv"), "query-result_260602150405.csv");
  } finally {
    vi.useRealTimers();
  }
});

test("full query result CSV export streams through the backend without loading all rows", async () => {
  useSettingsStore().updateEditorSettings({ globalDateTimeExportFormat: "YYYY/M/D HH:mm:ss" });
  const { composable, fullExportResult, queryResultExportRequest, exportProgressDialog, exportProgressState } = buildExportHarness();

  await composable.exportCsv();

  assert.equal(fullExportResult.mock.calls.length, 0);
  assert.equal(queryResultExportRequest.mock.calls.length, 1);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 1);
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].dateTimeFormat, "YYYY/M/D HH:mm:ss");
  assert.equal(apiMock.exportQueryResultCsv.mock.calls.length, 0);
  assert.equal(exportProgressDialog.value, true);
  assert.equal(exportProgressState.value.status, "Done");
  assert.equal(exportProgressState.value.filePath, apiMock.startQueryResultExport.mock.calls[0][0].filePath);
});

test("streaming query result export translates terminal backend errors before the toast", async () => {
  const rawMessage = "XLSX supports at most 1,048,575 data rows. Use CSV export for the full result.";
  apiMock.startQueryResultExport.mockImplementationOnce(async (request, onProgress) => {
    onProgress({ exportId: request.exportId, tableName: "", rowsExported: 0, totalRows: 1_048_576, status: "Error", errorMessage: rawMessage });
    throw new Error(rawMessage);
  });
  const { composable, exportProgressState } = buildExportHarness();

  await composable.exportXlsx();

  assert.equal(exportProgressState.value.errorMessage, rawMessage);
  assert.deepEqual(toastMock.mock.calls.at(-1), ["导出失败：XLSX 最多支持 1,048,575 行数据，请使用 CSV 导出完整结果。", 5000]);
});

test("complete local query result XLSX export does not re-execute the query", async () => {
  const completeLocalResult: QueryResult = {
    columns: ["id", "name"],
    column_types: ["int4", "text"],
    rows: [
      [1, "Ada"],
      [2, "Lin"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: false,
  };
  const { composable, fullExportResult, queryResultExportRequest } = buildExportHarness({ completeLocalResult });

  await composable.exportXlsx();

  assert.equal(fullExportResult.mock.calls.length, 0);
  assert.equal(queryResultExportRequest.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 0);
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0]?.slice(1, 6), ["Export", ["id", "name"], ["int4", "text"], undefined, completeLocalResult.rows]);
});

test("MySQL joined query SQL export keeps result aliases instead of source column names", async () => {
  const download = installTextDownloadCapture();
  const completeLocalResult: QueryResult = {
    columns: ["order_no", "customer_name", "total_amount"],
    column_types: ["int", "varchar", "decimal"],
    rows: [[101, "Ada", "25.50"]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: false,
  };
  apiMock.buildExportSqlInsert.mockResolvedValueOnce("INSERT INTO `orders` (`order_no`, `customer_name`, `total_amount`) VALUES (101, 'Ada', 25.50);");

  try {
    const { composable } = buildExportHarness({
      columns: completeLocalResult.columns,
      rows: completeLocalResult.rows,
      completeLocalResult,
      databaseType: "mysql",
      tableMeta: {
        tableName: "orders",
        primaryKeys: ["id"],
      },
      sourceColumns: ["id", undefined, "amount"],
    });

    await composable.exportSql();

    assert.deepEqual(apiMock.buildExportSqlInsert.mock.calls[0][0].columns, ["order_no", "customer_name", "total_amount"]);
    assert.deepEqual(apiMock.buildExportSqlInsert.mock.calls[0][0].rows, [[101, "Ada", "25.50"]]);
    assert.match((await download.content()) ?? "", /`order_no`, `customer_name`, `total_amount`/);
  } finally {
    download.restore();
  }
});

test("background SQL export keeps full result column types when visible columns are reordered", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue("/tmp/query-result.sql");
  const { composable, queryResultExportRequest } = buildExportHarness({
    columns: ["payload", "created_at"],
    columnTypes: ["jsonb", "timestamp"],
    allColumnTypes: ["bytea", "jsonb", "timestamp"],
    tableMeta: { tableName: "events", primaryKeys: ["id"] },
  });

  await composable.exportSql();

  assert.deepEqual(queryResultExportRequest.mock.calls[0][0].exportColumnTypes, ["bytea", "jsonb", "timestamp"]);
  assert.deepEqual(apiMock.startQueryResultExport.mock.calls[0][0].exportColumnTypes, ["bytea", "jsonb", "timestamp"]);
});

test("table data SQL export keeps source column names", async () => {
  const download = installTextDownloadCapture();
  apiMock.buildExportSqlInsert.mockResolvedValueOnce("INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada');");

  try {
    const { composable } = buildExportHarness({
      columns: ["display_id", "display_name"],
      rows: [[1, "Ada"]],
      databaseType: "mysql",
      context: "table-data",
      tableMeta: {
        tableName: "users",
        primaryKeys: ["id"],
      },
      sourceColumns: ["id", "name"],
    });

    await composable.exportSql([1]);

    assert.deepEqual(apiMock.buildExportSqlInsert.mock.calls[0][0].columns, ["id", "name"]);
    assert.match((await download.content()) ?? "", /`id`, `name`/);
  } finally {
    download.restore();
  }
});

test("complete local query result export removes only internal hidden columns", async () => {
  const completeLocalResult: QueryResult = {
    columns: ["id", "name", "__DBX_PK_id"],
    column_types: ["int4", "text", "int4"],
    rows: [
      [1, "Ada", 1],
      [2, "Lin", 2],
    ],
    hidden_column_indexes: [2],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: false,
  };
  const { composable } = buildExportHarness({ columns: ["id"], completeLocalResult });

  await composable.exportXlsx();

  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0]?.slice(1, 6), [
    "Export",
    ["id", "name"],
    ["int4", "text"],
    undefined,
    [
      [1, "Ada"],
      [2, "Lin"],
    ],
  ]);
});

test("complete local CSV, XLSX, and TXT exports honor the enabled row limit", async () => {
  useSettingsStore().updateEditorSettings({ exportRowLimitEnabled: true, exportRowLimit: 100 });
  const completeLocalResult: QueryResult = {
    columns: ["id"],
    column_types: ["int4"],
    rows: Array.from({ length: 101 }, (_, index) => [index + 1]),
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: false,
  };
  const { composable } = buildExportHarness({ completeLocalResult });

  await composable.exportCsv();
  assert.equal(apiMock.exportQueryResultCsv.mock.calls[0]?.[2].length, 100);

  await composable.exportXlsx();
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[0]?.[5].length, 100);

  const download = installTextDownloadCapture();
  try {
    await composable.exportTxt();
    const lines = (await download.content())?.split("\n");
    assert.equal(lines?.length, 101);
    assert.equal(lines?.at(-1), "100");
  } finally {
    download.restore();
  }
});

test("full query result CSV export defaults to the saved SQL title", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));
    const { composable, queryResultExportRequest } = buildExportHarness({ exportFileBaseName: "daily/report.sql" });

    await composable.exportCsv();

    assert.equal(queryResultExportRequest.mock.calls[0][0].filePath, "daily_report_260602150405.csv");
    assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].filePath, "daily_report_260602150405.csv");
  } finally {
    vi.useRealTimers();
  }
});

test("selected query result CSV export defaults to the saved SQL title", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));
    const { composable } = buildExportHarness({ exportFileBaseName: "daily/report.sql" });

    await composable.exportCsv([1]);

    assert.equal(apiMock.exportQueryResultCsv.mock.calls[0][0], "daily_report_260602150405.csv");
  } finally {
    vi.useRealTimers();
  }
});

test("table data export keeps the table name as the default file base", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));
    const { composable, exportProgressState } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls[0][0].filePath, "users_260602150405.csv");
    assert.equal(exportProgressState.value.filePath, "users_260602150405.csv");
  } finally {
    vi.useRealTimers();
    restoreStorage();
  }
});

test("query result CSV cancel handler passes export and execution ids", async () => {
  const { composable, exportCancelHandler } = buildExportHarness();
  let resolveExport!: () => void;
  apiMock.startQueryResultExport.mockImplementationOnce(async (_request, onProgress) => {
    await new Promise<void>((resolve) => {
      resolveExport = () => {
        onProgress({
          exportId: _request.exportId,
          tableName: "",
          rowsExported: 1,
          totalRows: 2,
          status: "Cancelled",
          errorMessage: "Export cancelled",
        });
        resolve();
      };
    });
    return {
      exportId: _request.exportId,
      tableName: "",
      rowsExported: 1,
      totalRows: 2,
      status: "Cancelled",
      errorMessage: "Export cancelled",
    };
  });

  const exportPromise = composable.exportCsv();
  await vi.waitFor(() => assert.ok(exportCancelHandler.value));
  await exportCancelHandler.value?.();

  const request = apiMock.startQueryResultExport.mock.calls[0][0];
  assert.deepEqual(apiMock.cancelQueryResultExport.mock.calls[0], [request.exportId, "exec-1"]);

  resolveExport();
  await exportPromise;
});

test("missing query result export request does not fall back to the in-memory path", async () => {
  const { composable, fullExportResult, queryResultExportRequest } = buildExportHarness();
  queryResultExportRequest.mockResolvedValueOnce(undefined);

  await composable.exportCsv();

  assert.equal(queryResultExportRequest.mock.calls.length, 1);
  assert.equal(fullExportResult.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultCsv.mock.calls.length, 0);
});

test("selected query result CSV export keeps the existing in-memory path", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness();

  await composable.exportCsv([1]);

  assert.equal(queryResultExportRequest.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultCsv.mock.calls.length, 1);
  assert.deepEqual(apiMock.exportQueryResultCsv.mock.calls[0][1], ["id", "name"]);
  assert.deepEqual(apiMock.exportQueryResultCsv.mock.calls[0][2], [[1, "Ada"]]);
});

test("selected query result CSV export formats only typed temporal columns", async () => {
  useSettingsStore().updateEditorSettings({ globalDateTimeExportFormat: "YYYY/M/D HH:mm:ss" });
  const rawDateTime = "2024-02-25 13:02:15";
  const { composable } = buildExportHarness({
    columns: ["created_at", "note"],
    columnTypes: ["timestamp", "varchar"],
    rows: [[rawDateTime, rawDateTime]],
  });

  await composable.exportCsv([1]);

  assert.deepEqual(apiMock.exportQueryResultCsv.mock.calls[0][2], [["2024/2/25 13:02:15", rawDateTime]]);
});

test("selected query result XLSX export uses the current source label as the sheet name", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness({ currentResultLabel: "aaa.apis", columnTypes: ["bigint(20)", "varchar(64)"] });

  await composable.exportXlsx([1]);

  assert.equal(queryResultExportRequest.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls.length, 1);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[0][1], "aaa.apis");
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0][2], ["id", "name"]);
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0][3], ["bigint(20)", "varchar(64)"]);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[0][4], undefined);
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0][5], [[1, "Ada"]]);
});

test("selected query result XLSX export forwards the numericColumnRightAlign setting to the backend", async () => {
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ numericColumnRightAlign: false });
  const { composable } = buildExportHarness({ columnTypes: ["bigint(20)", "varchar(64)"] });

  await composable.exportXlsx([1]);

  assert.equal(apiMock.exportQueryResultXlsx.mock.calls.length, 1);
  // Argument 6 is `numericColumnRightAlign`, and must reflect the persisted
  // setting rather than always defaulting to true.
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[0][6], false);

  settingsStore.updateEditorSettings({ numericColumnRightAlign: true });
  await composable.exportXlsx([1]);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[1][6], true);
});

test("streaming query result XLSX export carries numericColumnRightAlign in the backend request", async () => {
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ numericColumnRightAlign: false });
  const { composable, queryResultExportRequest } = buildExportHarness();

  await composable.exportXlsxWithSql();

  assert.equal(queryResultExportRequest.mock.calls.length, 1);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 1);
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].numericColumnRightAlign, false);
});

test("streaming XLSX with SQL marks the backend request as opt in", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness();

  await composable.exportXlsxWithSql();

  assert.equal(queryResultExportRequest.mock.calls[0][0].includeSqlSheet, true);
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].includeSqlSheet, true);
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].sql, "SELECT * FROM users");
  assert.equal(apiMock.exportQueryResultsXlsx.mock.calls.length, 0);
});

test("streaming TXT export remains on the backend path without a SQL sheet", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness();

  await composable.exportTxt();

  assert.equal(queryResultExportRequest.mock.calls[0][0].format, "txt");
  assert.equal(queryResultExportRequest.mock.calls[0][0].includeSqlSheet, false);
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].format, "txt");
  assert.equal(apiMock.startQueryResultExport.mock.calls[0][0].includeSqlSheet, false);
  assert.equal(apiMock.exportQueryResultsXlsx.mock.calls.length, 0);
});

test("selected XLSX with SQL uses the effective result SQL in a second worksheet", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness({ currentResultLabel: "public.users" });

  await composable.exportXlsxWithSql([1]);

  assert.equal(queryResultExportRequest.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultsXlsx.mock.calls.length, 1);
  const worksheets = apiMock.exportQueryResultsXlsx.mock.calls[0][1];
  assert.equal(worksheets[0].sheetName, "public.users");
  assert.deepEqual(worksheets[0].rows, [[1, "Ada"]]);
  assert.equal(worksheets[1].sheetName, "SQL");
  assert.deepEqual(worksheets[1].rows, [["SELECT * FROM users ORDER BY id DESC"]]);
});

test("all-results XLSX with SQL maps each result set to its source statement", async () => {
  const allExportResults = [
    { sheetName: "Result 1", result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, sourceStatement: "SELECT 1" }, sql: "SELECT 1" },
    { sheetName: "Result 2", result: { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, sourceStatement: "SELECT 2" }, sql: "SELECT 2 ORDER BY 1" },
  ];
  const { composable } = buildExportHarness({ allExportResults });

  await composable.exportAllResultsXlsxWithSql();

  const worksheets = apiMock.exportQueryResultsXlsx.mock.calls[0][1];
  assert.equal(worksheets.length, 3);
  assert.equal(worksheets[2].sheetName, "SQL");
  assert.deepEqual(worksheets[2].rows, [
    ["Result 1", "SELECT 1"],
    ["Result 2", "SELECT 2 ORDER BY 1"],
  ]);
});

test("cancelled query result CSV export clears the cancel handler without using the in-memory path", async () => {
  const { composable, fullExportResult, exportProgressState, exportCancelHandler } = buildExportHarness();
  apiMock.startQueryResultExport.mockImplementationOnce(async (_request, onProgress) => {
    onProgress({
      exportId: _request.exportId,
      tableName: "",
      rowsExported: 1,
      totalRows: 2,
      status: "Cancelled",
      errorMessage: "Export cancelled",
    });
    return {
      exportId: _request.exportId,
      tableName: "",
      rowsExported: 1,
      totalRows: 2,
      status: "Cancelled",
      errorMessage: "Export cancelled",
    };
  });

  await composable.exportCsv();

  assert.equal(fullExportResult.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 1);
  assert.equal(apiMock.exportQueryResultCsv.mock.calls.length, 0);
  assert.equal(exportProgressState.value.status, "Cancelled");
  assert.equal(exportProgressState.value.errorMessage, "Export cancelled");
  assert.equal(exportCancelHandler.value, null);
});

test("table data export leaves row limit unset by default", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    const { composable } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls.length, 1);
    assert.equal(apiMock.startTableExport.mock.calls[0][0].rowLimit, null);
  } finally {
    restoreStorage();
  }
});

test("table data export passes the global date time export format", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    useSettingsStore().updateEditorSettings({ globalDateTimeExportFormat: "YYYY/MM/DD HH:mm:ss" });
    const { composable } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls[0][0].dateTimeFormat, "YYYY/MM/DD HH:mm:ss");
  } finally {
    restoreStorage();
  }
});

test("table data export requests row count for determinate progress", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    const { composable, exportProgressState } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls.length, 1);
    assert.equal(apiMock.startTableExport.mock.calls[0][0].skipCount, false);
    assert.equal(exportProgressState.value.totalRows, 2);
  } finally {
    restoreStorage();
  }
});

test("table data export passes row limit when enabled", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ exportRowLimitEnabled: true, exportRowLimit: 12_345 });
    const { composable } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls.length, 1);
    assert.equal(apiMock.startTableExport.mock.calls[0][0].rowLimit, 12_345);
  } finally {
    restoreStorage();
  }
});
