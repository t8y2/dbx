// @vitest-environment happy-dom
import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridEditor } from "@/composables/useDataGridEditor";
import type { CellValue } from "@/lib/dataGrid/cellValue";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  prepareDataGridSave: vi.fn(),
  executeBatch: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  prepareDataGridSave: mocks.prepareDataGridSave,
  executeBatch: mocks.executeBatch,
  executeConditionalUpdate: vi.fn(),
  cancelConditionalUpdate: vi.fn(),
  executeInTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  executeQuery: vi.fn(),
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig }),
}));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({ add: vi.fn() }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({}),
}));

function createEditor(includeDatabaseNameInSaveSql: boolean) {
  const rows = ref<CellValue[][]>([["alpha"]]);
  let editor: ReturnType<typeof useDataGridEditor>;
  editor = useDataGridEditor({
    result: computed(() => ({ columns: ["name"], rows: rows.value })),
    editable: computed(() => true),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    tableMeta: computed(() => ({
      database: "dbx",
      tableName: "filter_probe",
      columns: [{ name: "name", data_type: "varchar(50)" }],
      primaryKeys: ["id"],
    })),
    sourceColumns: computed(() => undefined),
    includeDatabaseNameInSaveSql: computed(() => includeDatabaseNameInSaveSql),
    onExecuteSql: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    currentWhereInput: computed(() => undefined),
    orderByInput: ref(""),
    rowStatusFilter: ref("all"),
    pageSize: ref(100),
    currentPage: ref(1),
    onCellValueChanged: undefined,
    getRowItem: (rowId) => {
      if (rowId < 0) return undefined;
      const row = rows.value[rowId];
      if (!row) return undefined;
      const changes = editor.dirtyRows.value.get(rowId);
      return {
        id: rowId,
        sourceIndex: rowId,
        data: row.map((value, columnIndex) => (changes?.has(columnIndex) ? (changes.get(columnIndex) ?? null) : value)),
        isNew: false,
        isDeleted: false,
        isDirtyCol: row.map((_, columnIndex) => changes?.has(columnIndex) ?? false),
        status: changes?.size ? "edited" : "normal",
      };
    },
    emit: vi.fn(),
  });
  editor.applyCellValue(0, 0, "changed");
  return editor;
}

describe("useDataGridEditor save SQL database qualification", () => {
  beforeEach(() => {
    mocks.prepareDataGridSave.mockReset();
    mocks.executeBatch.mockReset();
    mocks.getConfig.mockReset();
    mocks.getConfig.mockReturnValue(undefined);
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE x"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue([]);
  });

  it("forwards the include-database-name setting to the save statement builder", async () => {
    await createEditor(true).saveChanges();
    expect(mocks.prepareDataGridSave.mock.calls[0]![0]).toMatchObject({ includeDatabaseName: true });

    await createEditor(false).saveChanges();
    expect(mocks.prepareDataGridSave.mock.calls[1]![0]).toMatchObject({ includeDatabaseName: false });
  });
});
