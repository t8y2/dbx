import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseDataGridExportOptions } from "@/composables/useDataGridExport";
import type { QueryResultExportRequest } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  noteExpired: vi.fn(),
  save: vi.fn(),
  mode: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...original,
    startQueryResultExport: mocks.start,
    cancelQueryResultExport: mocks.cancel,
    createQueryResultTempFile: vi.fn(async (extension: string) => `C:/exports/temp.${extension}`),
    openQueryResultTempFile: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/export/exportPath", () => ({
  promptExportSavePath: mocks.save,
  autoRevealExportedPathIfConfigured: vi.fn(),
}));
vi.mock("@/lib/export/exportExecutionMode", () => ({ getDefaultExportExecutionMode: mocks.mode }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ noteExpiredManualTransaction: mocks.noteExpired }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: { message?: string }) => (params?.message ? `${key}: ${params.message}` : key) }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));
vi.mock("@/composables/useDataGridExtractor", () => ({ useDataGridExtractor: () => ({ canCopyWithExtractor: vi.fn() }) }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app" }),
    ensureConnected: vi.fn(async () => undefined),
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
  }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      defaultExportMode: "immediate",
      exportBatchSize: 1000,
      exportRowLimitEnabled: false,
      csvQuoteMode: "minimal",
      csvNullMode: "empty",
      numericColumnRightAlign: true,
    },
  }),
}));

function expiredTransactionError() {
  return new Error("Transaction session not found or expired; it may have been auto-rolled back due to inactivity");
}

function capturedRequest(options: { exportId: string; filePath: string; format: QueryResultExportRequest["format"] }): QueryResultExportRequest {
  return {
    exportId: options.exportId,
    connectionId: "mysql-1",
    database: "app",
    sql: "UPDATE users SET active = 1",
    queryBaseSql: "UPDATE users SET active = 1",
    databaseType: "mysql",
    useAgentCursor: false,
    filePath: options.filePath,
    format: options.format,
    pageSize: 1000,
    keysetOptimizationEnabled: false,
    txnSessionId: "txn-expired",
    executionId: "exec-1",
  };
}

function fixture() {
  const progress = ref({
    title: "",
    tableName: "",
    format: "",
    rowsExported: 0,
    totalRows: null as number | null,
    status: "",
    errorMessage: null as string | null,
    filePath: null as string | null,
  });
  const options: UseDataGridExportOptions = {
    columns: computed(() => ["ID"]),
    displayItems: computed(() => []),
    sql: computed(() => "SELECT ID FROM users"),
    tableMeta: computed(() => undefined),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "mysql-1"),
    database: computed(() => "app"),
    context: computed(() => "results"),
    sourceColumns: computed(() => ["ID"]),
    columnTypes: computed(() => ["INT"]),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
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
    captureQueryResultExportRequest: () => async (buildOptions) => capturedRequest(buildOptions),
    queryResultExportRequest: async (buildOptions) => capturedRequest(buildOptions),
    exportProgressState: progress,
    exportProgressDialog: ref(false),
    exportCanMinimize: ref(false),
    exportCancelHandler: ref(null),
  };
  return { options, progress };
}

describe("data grid query result export with an expired manual transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mocks.save.mockResolvedValue("C:/exports/out.csv");
    mocks.mode.mockReturnValue("immediate");
    mocks.start.mockImplementation(async (request: QueryResultExportRequest, onProgress: (progress: unknown) => void) => {
      const error = expiredTransactionError();
      // The Tauri bridge reports the terminal Error progress before rejecting.
      onProgress({ exportId: request.exportId, tableName: "Query Result", rowsExported: 0, totalRows: null, status: "Error", errorMessage: error.message });
      throw error;
    });
  });

  it.each(["Transaction session not found or expired; it may have been auto-rolled back due to inactivity", "Transaction was auto-rolled back due to inactivity"])("clears the dead session on the source tab and reports the transaction as unavailable: %s", async (message) => {
    mocks.start.mockImplementation(async (request: QueryResultExportRequest, onProgress: (progress: unknown) => void) => {
      // The Tauri bridge reports the terminal Error progress before rejecting.
      onProgress({ exportId: request.exportId, tableName: "Query Result", rowsExported: 0, totalRows: null, status: "Error", errorMessage: message });
      throw new Error(message);
    });
    const { useDataGridExport } = await import("@/composables/useDataGridExport");
    const { options, progress } = fixture();
    const state = useDataGridExport(options);

    await state.exportCsv();

    expect(mocks.noteExpired).toHaveBeenCalledWith("txn-expired", expect.any(Error));
    expect(mocks.toast).toHaveBeenCalledWith("grid.exportFailed: exportProgress.transactionUnavailable", 5000);
    expect(progress.value.status).toBe("Error");
    expect(progress.value.errorMessage).toBe("exportProgress.transactionUnavailable");
  });

  it("still surfaces the original error when the export fails for another reason", async () => {
    mocks.start.mockRejectedValue(new Error("disk full"));
    const { useDataGridExport } = await import("@/composables/useDataGridExport");
    const { options } = fixture();
    const state = useDataGridExport(options);

    await state.exportCsv();

    expect(mocks.noteExpired).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("grid.exportFailed: disk full", 5000);
  });
});
