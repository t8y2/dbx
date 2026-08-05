import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { useExportTracker } from "@/composables/useExportTracker";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue("C:/exports/query-result.sql"),
}));

vi.mock("@/lib/backend/api", () => ({
  startQueryResultExport: vi.fn(),
  cancelQueryResultExport: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/composables/useDataGridExtractor", () => ({
  useDataGridExtractor: () => ({
    copyWithExtractor: vi.fn(),
    previewWithExtractor: vi.fn(),
    canCopyWithExtractor: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      exportBatchSize: 1000,
      globalDateTimeExportFormat: "",
      numericColumnRightAlign: true,
    },
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/i18n", () => ({
  default: { install() {} },
}));

function createOptions(overrides: Partial<UseDataGridExportOptions> = {}): UseDataGridExportOptions {
  const base: UseDataGridExportOptions = {
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => []),
    sql: computed(() => "SELECT id, name FROM users"),
    tableMeta: computed(() => ({
      tableName: "users",
      primaryKeys: [],
      columns: [
        { name: "id", data_type: "int" },
        { name: "name", data_type: "text" },
      ],
    })),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "results"),
    sourceColumns: computed(() => ["id", "name"]),
    columnTypes: computed(() => ["int4", "text"]),
    allColumnTypes: computed(() => ["int4", "text"]),
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
    hasCompleteLocalResult: computed(() => false),
    queryResultExportRequest: vi.fn(async (request) => ({
      ...request,
      connectionId: "connection-1",
      database: "dbx",
      databaseType: "postgres",
      queryBaseSql: "SELECT id, name FROM users",
      sql: "SELECT id, name FROM users",
      executionId: "execution-1",
    })),
  };
  return { ...base, ...overrides };
}

describe("query result SQL export progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tracker = useExportTracker();
    for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
    vi.mocked(api.startQueryResultExport).mockImplementation(async (_request, onProgress) => {
      onProgress({ exportId: "sql-export", tableName: "Query Result", rowsExported: 1, totalRows: 1, status: "Done", errorMessage: null });
      return { exportId: "sql-export", tableName: "Query Result", rowsExported: 1, totalRows: 1, status: "Done", errorMessage: null };
    });
  });

  afterEach(() => {
    const tracker = useExportTracker();
    for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
  });

  it("uses the same progress dialog and task lifecycle as CSV/XLSX", async () => {
    const progressDialog = ref(false);
    const progressState = ref({
      title: "",
      tableName: "",
      format: "",
      rowsExported: 0,
      totalRows: null as number | null,
      status: "",
      errorMessage: null as string | null,
      filePath: null as string | null,
      startedAt: undefined as number | undefined,
      finishedAt: undefined as number | undefined,
    });
    const cancelHandler = ref<(() => Promise<void>) | null>(null);
    const canMinimize = ref(false);
    const state = useDataGridExport(createOptions({ exportProgressDialog: progressDialog, exportProgressState: progressState, exportCancelHandler: cancelHandler, exportCanMinimize: canMinimize }));

    await state.exportSql();

    expect(progressDialog.value).toBe(true);
    expect(canMinimize.value).toBe(false);
    expect(progressState.value.format).toBe("sql");
    expect(progressState.value.status).toBe("Done");
    expect(progressState.value.rowsExported).toBe(1);
    expect(progressState.value.startedAt).toEqual(expect.any(Number));
    expect(progressState.value.finishedAt).toEqual(expect.any(Number));
    expect(cancelHandler.value).toBeNull();
    expect(api.startQueryResultExport).toHaveBeenCalledWith(expect.objectContaining({ format: "sql", exportTableName: "users", exportColumnTypes: ["int4", "text"] }), expect.any(Function));
  });
});
