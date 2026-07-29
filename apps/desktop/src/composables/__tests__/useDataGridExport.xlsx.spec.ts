// @vitest-environment happy-dom

import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  exportQueryResultsXlsx: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({
  default: {
    emits: ["confirm"],
    mounted(this: { $emit: (event: string, value: boolean) => void }) {
      queueMicrotask(() => this.$emit("confirm", true));
    },
    render() {
      return null;
    },
  },
}));

vi.mock("@/i18n", () => ({
  default: { install() {} },
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/composables/useDataGridExtractor", () => ({
  useDataGridExtractor: () => ({
    copyWithExtractor: vi.fn(),
    previewWithExtractor: vi.fn(),
    canCopyWithExtractor: vi.fn(),
  }),
}));

vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({
    addTask: vi.fn(),
    updateTableExportTask: vi.fn(),
    registerTaskCancelHandler: vi.fn(),
    unregisterTaskCancelHandler: vi.fn(),
    removeTask: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      globalDateTimeExportFormat: "",
      numericColumnRightAlign: true,
    },
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  exportQueryResultsXlsx: mocks.exportQueryResultsXlsx,
}));

function queryResult(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns,
    column_types: columns.map(() => "varchar"),
    rows,
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function createOptions(): UseDataGridExportOptions {
  return {
    columns: computed(() => ["id"]),
    displayItems: computed(() => []),
    sql: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "users",
      primaryKeys: [],
      columns: [
        { name: "id", data_type: "int", is_nullable: false, comment: "Identifier" },
        { name: "name", data_type: "varchar", is_nullable: false, comment: "Display name" },
      ],
    })),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "results"),
    sourceColumns: computed(() => ["id"]),
    columnTypes: computed(() => ["int"]),
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
    selectedRowIds: ref(new Set()),
    hasRowSelection: computed(() => false),
    allExportResults: computed(() => [
      { sheetName: "Ids", result: queryResult(["id"], [[1]]) },
      { sheetName: "Names", result: queryResult(["name"], [["Ada"]]) },
    ]),
  };
}

describe("useDataGridExport XLSX headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps comments independently for every result sheet", async () => {
    const state = useDataGridExport(createOptions());

    await state.exportAllResultsXlsx();

    expect(mocks.exportQueryResultsXlsx).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.objectContaining({ sheetName: "Ids", columnComments: ["Identifier"] }), expect.objectContaining({ sheetName: "Names", columnComments: ["Display name"] })]));
  });
});
