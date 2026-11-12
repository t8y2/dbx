import { computed, effectScope, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { CellSelectionMatrix } from "@/lib/dataGrid/gridSelection";
import { extractDataGridSelection } from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";
import { clearDataGridClipboardCopy, parseDataGridClipboard } from "@/lib/dataGrid/dataGridClipboard";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/common/clipboard", async (original) => ({ ...(await original<typeof import("@/lib/common/clipboard")>()), copyToClipboard: vi.fn() }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), extractDataGridSelection: vi.fn() }));

function item(id: number, data: unknown[], extra = {}) {
  return { id, sourceIndex: id - 1, data, isDirtyCol: data.map(() => false), isNew: false, isDeleted: false, status: "clean", ...extra };
}

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

describe("copy the whole active result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDataGridClipboardCopy();
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "all rows", mimeType: "text/plain", fileExtension: "txt", rowCount: 2, columnCount: 2 });
  });

  it.each(["cell", "column", "rows", "discrete", "none"])("copies all loaded rows without changing an existing %s selection", async (selection) => {
    const state = createState({ hasColumnSelection: computed(() => selection === "column"), hasCellSelection: computed(() => selection !== "none") });
    if (selection === "discrete" || selection === "none") state.matrix.value = null;
    if (selection === "rows") state.selectedRowIds.value.add(2);
    const originalMatrix = state.matrix.value;
    const originalRowIds = [...state.selectedRowIds.value];
    const originalContext = state.contextCell.value;

    await expect(state.copyAllWithPreference("csv-with-headers")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        extractor: "csv-with-headers",
        rows: [
          [1, "Ada"],
          [2, "Grace"],
        ],
        selectedColumnIndexes: [0, 1],
        selectionKind: "cells",
      }),
    );
    expect(copyToClipboard).toHaveBeenCalledWith("all rows");
    expect(state.matrix.value).toBe(originalMatrix);
    expect([...state.selectedRowIds.value]).toEqual(originalRowIds);
    expect(state.contextCell.value).toBe(originalContext);
    expect(toast).toHaveBeenCalledWith('grid.copiedRows:{"count":2}');
  });

  it("preserves filtered row order, hidden and reordered columns and ignores draft rows", async () => {
    const source = [item(1, [1, "private-1", "Ada"]), item(2, [2, "private-2", "Grace"]), item(3, [3, "private-3", "Linus"])];
    const state = createState({
      columns: computed(() => ["name", "id"]),
      sourceColumns: computed(() => ["name", "id"]),
      visibleColumnIndexes: computed(() => [2, 0]),
      allColumns: computed(() => ["id", "hidden", "name"]),
      allSourceColumns: computed(() => ["id", "hidden", "name"]),
      allDisplayItems: computed(() => [source[2]!, source[0]!]),
      displayItems: computed(() => [item(3, ["Linus", 3]), item(-1, ["", null], { isDraft: true }), item(1, ["Ada", 1])]),
    });
    await state.copyAllWithPreference("json");
    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        extractor: "json",
        rows: [
          ["Linus", 3],
          ["Ada", 1],
        ],
        columns: [expect.objectContaining({ displayName: "name" }), expect.objectContaining({ displayName: "id" })],
      }),
    );
  });

  it("honors extractor options and only copies loaded rows without fetching other pages", async () => {
    const fullExportResult = vi.fn();
    const extractorOptions = { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, dsv: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv, columnSeparator: ";" } };
    const state = createState({ extractorOptions: computed(() => extractorOptions), fullExportResult, partialLoadCopyInfo: computed(() => ({ loadedRows: 2, totalRows: 500, hasMore: true })) });
    await state.copyAllWithPreference("csv-with-headers");
    expect(extractDataGridSelection).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ dsv: expect.objectContaining({ columnSeparator: ";" }) }) }));
    expect(fullExportResult).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('grid.copyPartialRowsHintWithTotal:{"loaded":2,"total":500}', 5000);
  });

  it("resolves large values and retains the raw matrix for TSV paste-back", async () => {
    const resolveSourceValues = vi.fn(
      async () =>
        new Map([
          [1, new Map([[1, "full text"]])],
          [2, new Map([[1, null]])],
        ]),
    );
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "id\tname\n1\tfull text\n2\t", mimeType: "text/tab-separated-values", fileExtension: "tsv", rowCount: 2, columnCount: 2 });
    const state = createState({ resolveSourceValues });
    await state.copyAllWithPreference("tsv-with-headers");
    expect(resolveSourceValues).toHaveBeenCalledWith([1, 2], [0, 1]);
    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          [1, "full text"],
          [2, null],
        ],
      }),
    );
    expect(parseDataGridClipboard("id\tname\n1\tfull text\n2\t")).toEqual([
      ["id", "name"],
      ["1", "full text"],
      ["2", null],
    ]);
  });

  it.each(["guard", "disposal"])("does not write the clipboard after %s invalidates an asynchronous copy", async (invalidation) => {
    let deliver!: (value: Map<number, Map<number, string>>) => void;
    const resolveSourceValues = vi.fn(
      () =>
        new Promise<Map<number, Map<number, string>>>((resolve) => {
          deliver = resolve;
        }),
    );
    const scope = effectScope();
    const state = scope.run(() => createState({ resolveSourceValues }))!;
    let valid = true;
    const copying = state.copyAllWithPreference("json", () => valid);
    if (invalidation === "guard") valid = false;
    else scope.stop();
    deliver(new Map());
    await expect(copying).resolves.toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("grid.copiedRows"));
    scope.stop();
  });

  it("does nothing when there are no result rows or visible columns", async () => {
    await expect(createState({ displayItems: computed(() => []) }).copyAllWithPreference("smart")).resolves.toBe(false);
    await expect(createState({ columns: computed(() => []) }).copyAllWithPreference("json")).resolves.toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(extractDataGridSelection).not.toHaveBeenCalled();
  });

  it("keeps the original Copy all TSV behavior", async () => {
    await createState().copyAll();
    expect(copyToClipboard).toHaveBeenCalledWith("id\tname\n1\tAda\n2\tGrace");
    expect(extractDataGridSelection).not.toHaveBeenCalled();
  });

  it("honors JSON formatting options", async () => {
    const extractorOptions = { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, json: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.json, pretty: false, valuesOnly: true } };
    await createState({ extractorOptions: computed(() => extractorOptions) }).copyAllWithPreference("json");
    expect(extractDataGridSelection).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ json: expect.objectContaining({ pretty: false, valuesOnly: true }) }) }));
  });

  it("copies every Mongo INSERT document even when only one cell is selected", async () => {
    const state = createState({
      databaseType: computed(() => "mongodb"),
      copyInsertTargetLabel: computed(() => "users"),
      mongoDocuments: computed(() => [
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ]),
    });
    await expect(state.copyAllWithPreference("sql-inserts")).resolves.toBe(true);
    const text = vi.mocked(copyToClipboard).mock.calls[0]![0];
    expect(text).toContain("Ada");
    expect(text).toContain("Grace");
    expect(extractDataGridSelection).not.toHaveBeenCalled();
  });

  it("copies every eligible Mongo UPDATE independently of selected rows", async () => {
    const state = createState({
      databaseType: computed(() => "mongodb"),
      columns: computed(() => ["_id", "name"]),
      sourceColumns: computed(() => ["_id", "name"]),
      mongoUpdateTarget: computed(() => ({ collection: "users", idColumn: "_id" })),
      mongoDocuments: computed(() => [
        { _id: 1, name: "Ada" },
        { _id: 2, name: "Grace" },
      ]),
    });
    state.selectedRowIds.value.add(1);
    await expect(state.copyAllWithPreference("sql-updates")).resolves.toBe(true);
    const text = vi.mocked(copyToClipboard).mock.calls[0]![0];
    expect(text.match(/\.updateOne\(/g)).toHaveLength(2);
    expect(text).toContain("Ada");
    expect(text).toContain("Grace");
  });
});
