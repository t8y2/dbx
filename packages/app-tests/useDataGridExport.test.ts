import { strict as assert } from "node:assert";
import { computed, ref } from "vue";
import { beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";

const apiMock = vi.hoisted(() => ({
  startQueryResultExport: vi.fn(),
  cancelQueryResultExport: vi.fn(),
  startTableExport: vi.fn(),
  cancelTableExport: vi.fn(),
  exportQueryResultCsv: vi.fn(),
  exportQueryResultXlsx: vi.fn(),
  exportQueryResultJson: vi.fn(),
  exportQueryResultMarkdown: vi.fn(),
  exportQueryResultsXlsx: vi.fn(),
  buildDataGridCopyInsertStatement: vi.fn(),
}));
const clipboardMock = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMock);
vi.mock("@/lib/clipboard", () => clipboardMock);
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

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

function buildExportHarness(options: { currentResultLabel?: string; exportFileBaseName?: string } = {}) {
  const exportProgressDialog = ref(false);
  const exportProgressState = ref({
    title: "",
    tableName: "",
    format: "csv",
    rowsExported: 0,
    totalRows: null as number | null,
    status: "",
    errorMessage: null as string | null,
  });
  const exportCancelHandler = ref<(() => Promise<void>) | null>(null);
  const fullExportResult = vi.fn(async () => {
    throw new Error("fullExportResult should not be called for streaming CSV/XLSX query exports");
  });
  const queryResultExportRequest = vi.fn(async (options: { exportId: string; filePath: string; format: "csv" | "xlsx" }) => ({
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
    pageSize: 1000,
    rowLimit: 100000,
    totalRows: 2,
    timeoutSecs: 30,
    keysetOptimizationEnabled: true,
    clientSessionId: "tab-1:export",
    executionId: "exec-1",
  }));

  const composable = useDataGridExport({
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => [
      { id: 1, data: [1, "Ada"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
      { id: 2, data: [2, "Lin"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
    ]),
    sql: computed(() => "SELECT * FROM users"),
    tableMeta: computed(() => undefined),
    databaseType: computed(() => "postgres"),
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
    contextCell: ref(null),
    getRowItem: (rowId: number) =>
      [
        { id: 1, data: [1, "Ada"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
        { id: 2, data: [2, "Lin"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
      ].find((item) => item.id === rowId),
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
    fullExportResult,
    queryResultExportRequest,
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

test("copy MongoDB row as INSERT uses Mongo shell insert syntax", async () => {
  const contextCell = ref({ rowId: 1, rowIndex: 0, col: 0 });
  const jsonString = '{"endingBalance":{"beginningBalance":"0","endingBalance":"100","endingDate":"2024-11-25"},"Line":[]}';
  const row = {
    id: 1,
    data: ["6743e4bfa3f6f84bc3fff6c8", "577", "done", jsonString, 'ISODate("2024-11-25T02:45:36.184Z")'],
    isNew: false,
    isDeleted: false,
    isDirtyCol: [false, false, false, false, false],
    status: "",
  };
  const composable = useDataGridExport({
    columns: computed(() => ["_id", "accountId", "status", "data", "lastUpdatedDate"]),
    displayItems: computed(() => [row]),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    copyInsertTargetLabel: computed(() => "accounting_reconciliations"),
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

  await composable.prefetchRowAsInsertStatement(false);
  await composable.copyRowAsInsert();

  assert.equal(apiMock.buildDataGridCopyInsertStatement.mock.calls.length, 0);
  assert.equal(
    clipboardMock.copyToClipboard.mock.calls[0][0],
    'db.getCollection("accounting_reconciliations").insert({"_id":ObjectId("6743e4bfa3f6f84bc3fff6c8"),"accountId":577,"status":"done","data":{"endingBalance":{"beginningBalance":"0","endingBalance":"100","endingDate":"2024-11-25"},"Line":[]},"lastUpdatedDate":ISODate("2024-11-25T02:45:36.184Z")});',
  );
});

test("copy MongoDB rows as INSERT excludes _id for insert without primary keys", async () => {
  const selectedRowIds = ref(new Set([1, 2]));
  const rows = [
    { id: 1, data: ["6743e4bfa3f6f84bc3fff6c8", "done"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
    { id: 2, data: ["6743e4bfa3f6f84bc3fff6c9", "draft"], isNew: false, isDeleted: false, isDirtyCol: [false, false], status: "" },
  ];
  const composable = useDataGridExport({
    columns: computed(() => ["_id", "status"]),
    displayItems: computed(() => rows),
    sql: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "accounting_reconciliations",
      primaryKeys: ["_id"],
    })),
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
    contextCell: ref(null),
    getRowItem: (rowId: number) => rows.find((item) => item.id === rowId),
    selectedRowIds,
    hasRowSelection: computed(() => true),
  });

  await composable.prefetchRowAsInsertStatement(true);
  await composable.copyRowAsInsertWithoutPrimaryKeys();

  assert.equal(apiMock.buildDataGridCopyInsertStatement.mock.calls.length, 0);
  assert.equal(clipboardMock.copyToClipboard.mock.calls[0][0], 'db.getCollection("accounting_reconciliations").insertMany([{"status":"done"},{"status":"draft"}]);');
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
  const { composable, fullExportResult, queryResultExportRequest, exportProgressDialog, exportProgressState } = buildExportHarness();

  await composable.exportCsv();

  assert.equal(fullExportResult.mock.calls.length, 0);
  assert.equal(queryResultExportRequest.mock.calls.length, 1);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 1);
  assert.equal(apiMock.exportQueryResultCsv.mock.calls.length, 0);
  assert.equal(exportProgressDialog.value, true);
  assert.equal(exportProgressState.value.status, "Done");
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
    const { composable } = buildTableDataExportHarness();

    await composable.exportCsv();

    assert.equal(apiMock.startTableExport.mock.calls[0][0].filePath, "users_260602150405.csv");
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

test("selected query result XLSX export uses the current source label as the sheet name", async () => {
  const { composable, queryResultExportRequest } = buildExportHarness({ currentResultLabel: "aaa.apis" });

  await composable.exportXlsx([1]);

  assert.equal(queryResultExportRequest.mock.calls.length, 0);
  assert.equal(apiMock.startQueryResultExport.mock.calls.length, 0);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls.length, 1);
  assert.equal(apiMock.exportQueryResultXlsx.mock.calls[0][1], "aaa.apis");
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0][2], ["id", "name"]);
  assert.deepEqual(apiMock.exportQueryResultXlsx.mock.calls[0][3], [[1, "Ada"]]);
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
