import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import type { PartialLoadCopyInfo } from "@/lib/dataGrid/copyPartialLoadHint";
import type { CellSelectionMatrix } from "@/lib/dataGrid/gridSelection";
import { extractDataGridSelection } from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";
import { clearDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/common/clipboard", async (original) => ({ ...(await original<typeof import("@/lib/common/clipboard")>()), copyToClipboard: vi.fn() }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), extractDataGridSelection: vi.fn() }));

function item(id: number, data: unknown[], extra = {}) {
  return { id, sourceIndex: id - 1, data, isDirtyCol: data.map(() => false), isNew: false, isDeleted: false, status: "clean", ...extra };
}

/** Two loaded rows out of a 500-row result: the grid cannot see the whole set. */
const PARTIAL: PartialLoadCopyInfo = { loadedRows: 2, totalRows: 500, hasMore: true };

function createState(overrides: Partial<UseDataGridExportOptions> = {}) {
  const items = [item(1, [1, "Ada"]), item(2, [2, "Grace"])];
  const matrix = ref<CellSelectionMatrix | null>({ rowIndexes: [0], columnIndexes: [1], columns: ["name"], rows: [["Ada"]] });
  const selectedRowIds = ref(new Set<number>());
  const contextCell = ref({ rowId: 1, rowIndex: 0, col: 1 });
  const options: UseDataGridExportOptions = {
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => items),
    sql: computed(() => "SELECT id, name FROM users"),
    tableMeta: computed(() => ({
      tableName: "users",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_primary_key: true, is_nullable: false },
        { name: "name", data_type: "text", is_nullable: true },
      ],
    })),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "results"),
    sourceColumns: computed(() => ["id", "name"]),
    columnTypes: computed(() => ["int", "text"]),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => true),
    selectedCells: computed(() => matrix.value ?? { columns: ["name"], rows: [["Ada"], ["Grace"]] }),
    selectedCellMatrix: computed(() => matrix.value),
    selectedRange: computed(() => ({ startRow: 0, endRow: 0, startCol: 1, endCol: 1 })),
    contextCell,
    contextSelectionIsSynthetic: computed(() => true),
    getRowItem: (rowId) => items.find((entry) => entry.id === rowId),
    selectedRowIds,
    hasRowSelection: computed(() => selectedRowIds.value.size > 0),
    ...overrides,
  };
  return { ...useDataGridExport(options), matrix, selectedRowIds, contextCell };
}

function partialHintCalls() {
  return toast.mock.calls.filter(([message]) => String(message).startsWith("grid.copyPartialRowsHint"));
}

describe("partial-load copy hint scope (#15602)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDataGridClipboardCopy();
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "copied", mimeType: "text/plain", fileExtension: "txt", rowCount: 2, columnCount: 2 });
  });

  it("does not claim loaded rows when only some of them are copied", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => PARTIAL) });
    state.selectedRowIds.value.add(1);

    await expect(state.copyWithExtractor("csv-with-headers")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenCalledWith(expect.objectContaining({ rows: [[1, "Ada"]] }));
    expect(partialHintCalls()).toEqual([]);
    expect(toast).toHaveBeenCalledWith("grid.copied");
  });

  it("keeps the hint when the copy took every loaded row", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => PARTIAL) });
    state.selectedRowIds.value.add(1);
    state.selectedRowIds.value.add(2);

    await expect(state.copyWithExtractor("csv-with-headers")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          [1, "Ada"],
          [2, "Grace"],
        ],
      }),
    );
    expect(partialHintCalls()).toEqual([['grid.copyPartialRowsHintWithTotal:{"loaded":2,"total":500}', 5000]]);
  });

  it("keeps the hint for a whole-column copy, which does cover the loaded rows", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => PARTIAL), hasColumnSelection: computed(() => true) });
    state.matrix.value = { rowIndexes: [0, 1], columnIndexes: [1], columns: ["name"], rows: [["Ada"], ["Grace"]] };

    await expect(state.copyWithExtractor("tsv")).resolves.toBe(true);

    expect(partialHintCalls()).toEqual([['grid.copyPartialRowsHintWithTotal:{"loaded":2,"total":500}', 5000]]);
  });

  it("does not claim loaded rows for a single right-clicked cell copied as SQL", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => PARTIAL) });

    await expect(state.copyWithExtractor("sql-select")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenCalledWith(expect.objectContaining({ extractor: "sql-select", rows: [["Ada"]] }));
    expect(partialHintCalls()).toEqual([]);
  });

  it("does not claim loaded rows for a row copied as SQL INSERT", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => PARTIAL) });
    state.selectedRowIds.value.add(1);

    await expect(state.copyWithExtractor("sql-inserts")).resolves.toBe(true);

    expect(partialHintCalls()).toEqual([]);
  });

  it("stays silent when the grid already holds the complete result", async () => {
    const state = createState({ partialLoadCopyInfo: computed(() => null) });
    state.selectedRowIds.value.add(1);

    await expect(state.copyWithExtractor("csv-with-headers")).resolves.toBe(true);

    expect(partialHintCalls()).toEqual([]);
    expect(toast).toHaveBeenCalledWith("grid.copied");
  });
});
