import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { buildDataGridCopyUpdateStatements } from "@/lib/dataGrid/dataGridSql";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import type { CellSelectionMatrix, SelectionData } from "@/lib/dataGrid/gridSelection";
import { extractDataGridSelection } from "@/lib/backend/api";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS } from "@/lib/dataGrid/dataGridCopyExtractor";
import { clearDataGridClipboardCopy, parseDataGridClipboard } from "@/lib/dataGrid/dataGridClipboard";

const toast = vi.fn();

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: { message?: string }) => (params?.message ? `${key}: ${params.message}` : key) }),
}));

vi.mock("@/i18n", () => ({
  default: { install() {} },
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/common/clipboard")>();
  return {
    ...original,
    copyToClipboard: vi.fn(),
  };
});

vi.mock("@/lib/dataGrid/dataGridSql", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dataGrid/dataGridSql")>();
  return {
    ...original,
    buildDataGridCopyUpdateStatements: vi.fn(),
  };
});

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...original,
    extractDataGridSelection: vi.fn(),
  };
});

function row(data: unknown[]) {
  return {
    id: 1,
    data,
    isNew: false,
    isDeleted: false,
    isDirtyCol: data.map(() => false),
    status: "",
  };
}

function createMongoExportState(options: {
  columns: string[];
  item: ReturnType<typeof row> & { sourceIndex: number };
  items?: Array<ReturnType<typeof row> & { sourceIndex: number }>;
  mongoDocuments: unknown[];
  selectedCellMatrix?: CellSelectionMatrix;
  selectedRowIds?: Set<number>;
  mongoUpdateTarget?: false;
}) {
  const items = options.items ?? [options.item];
  const selectedRowIds = options.selectedRowIds ?? new Set<number>();
  const state: UseDataGridExportOptions = {
    columns: computed(() => options.columns),
    displayItems: computed(() => items),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    copyInsertTargetLabel: computed(() => "documents"),
    mongoUpdateTarget: computed(() => (options.mongoUpdateTarget === false ? undefined : { collection: "documents", idColumn: "_id" })),
    databaseType: computed(() => "mongodb"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "results"),
    sourceColumns: computed(() => options.columns),
    mongoDocuments: computed(() => options.mongoDocuments),
    columnTypes: computed(() => undefined),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => !!options.selectedCellMatrix),
    selectedCells: computed(() => options.selectedCellMatrix ?? { columns: [], rows: [] }),
    selectedCellMatrix: computed(() => options.selectedCellMatrix ?? null),
    selectedRange: computed(() => null),
    contextCell: ref({ rowId: options.item.id, rowIndex: 0, col: -1 }),
    contextSelectionIsSynthetic: ref(false),
    getRowItem: (rowId) => items.find((item) => item.id === rowId),
    selectedRowIds: ref(selectedRowIds),
    hasRowSelection: computed(() => selectedRowIds.size > 0),
  };
  return useDataGridExport(state);
}

function createExportState(
  tableMeta: DataGridTableMeta,
  columns = tableMeta.columns?.map((column) => column.name) ?? ["id", "name"],
  selectedCellMatrix?: CellSelectionMatrix,
  rowData?: unknown[],
  selectedCellsOverride?: SelectionData,
  rowDataList?: unknown[][],
  selectedRowIdValues: number[] = [],
  extractorOptions = DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
  hasColumnSelection = false,
  visibleColumnIndexes?: number[],
  isSyntheticContext = false,
) {
  const rows = (rowDataList ?? [rowData ?? columns.map((column, index) => (column === "id" ? 1 : `value-${index}`))]).map((data, index) => ({ ...row(data), id: index + 1 }));
  const item = rows[0]!;
  const selectedRowIds = ref(new Set(selectedRowIdValues));
  const options: UseDataGridExportOptions = {
    columns: computed(() => columns),
    displayItems: computed(() => rows),
    sql: computed(() => undefined),
    tableMeta: computed(() => tableMeta),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "table-data"),
    sourceColumns: computed(() => columns),
    visibleColumnIndexes: computed(() => visibleColumnIndexes ?? columns.map((_, index) => index)),
    columnTypes: computed(() => columns.map((column) => tableMeta.columns?.find((item) => item.name === column)?.data_type ?? "varchar")),
    extractorOptions: computed(() => extractorOptions),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => !!selectedCellMatrix || !!selectedCellsOverride),
    hasColumnSelection: computed(() => hasColumnSelection),
    selectedCells: computed(() => selectedCellMatrix ?? selectedCellsOverride ?? { columns: [], rows: [] }),
    selectedCellMatrix: computed(() => selectedCellMatrix ?? null),
    selectedRange: computed(() => null),
    contextCell: ref({ rowId: item.id, rowIndex: 0, col: isSyntheticContext ? 0 : -1 }),
    contextSelectionIsSynthetic: ref(isSyntheticContext),
    getRowItem: (rowId) => rows.find((candidate) => candidate.id === rowId),
    selectedRowIds,
    hasRowSelection: computed(() => selectedRowIds.value.size > 0),
  };
  return useDataGridExport(options);
}

const editableTable: DataGridTableMeta = {
  tableName: "users",
  primaryKeys: ["id"],
  columns: [
    { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
    { name: "name", data_type: "varchar", is_nullable: false },
  ],
};

describe("useDataGridExport prepared row statements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDataGridClipboardCopy();
  });

  it("builds SQL UPDATE from only selected writable columns while retaining a hidden primary key", async () => {
    const item = row([7, "Ada", true]);
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["active"],
      rows: [[true]],
    };
    const options: UseDataGridExportOptions = {
      columns: computed(() => ["display_name", "active"]),
      displayItems: computed(() => [{ ...item, data: ["Ada", true], isDirtyCol: [false, false] }]),
      allColumns: computed(() => ["id", "display_name", "active"]),
      allDisplayItems: computed(() => [item]),
      allSourceColumns: computed(() => ["id", "name", "active"]),
      visibleColumnIndexes: computed(() => [1, 2]),
      sql: computed(() => undefined),
      tableMeta: computed(() => ({
        tableName: "users",
        primaryKeys: ["id"],
        columns: [
          { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
          { name: "name", data_type: "varchar", is_nullable: false },
          { name: "active", data_type: "boolean", is_nullable: false },
        ],
      })),
      databaseType: computed(() => "mysql"),
      connectionId: computed(() => "connection-1"),
      database: computed(() => "dbx"),
      context: computed(() => "table-data"),
      sourceColumns: computed(() => ["name", "active"]),
      columnTypes: computed(() => ["varchar", "boolean"]),
      whereInput: computed(() => undefined),
      orderBy: computed(() => undefined),
      exportBatchSize: computed(() => 1000),
      hasCellSelection: computed(() => true),
      selectedCells: computed(() => matrix),
      selectedCellMatrix: computed(() => matrix),
      selectedRange: computed(() => ({ startRow: 0, endRow: 0, startCol: 1, endCol: 1 })),
      contextCell: ref({ rowId: item.id, rowIndex: 0, col: 1 }),
      contextSelectionIsSynthetic: ref(false),
      getRowItem: (rowId) => (rowId === item.id ? item : undefined),
      selectedRowIds: ref(new Set<number>()),
      hasRowSelection: computed(() => false),
    };
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: "UPDATE users SET active = TRUE WHERE id = 7;",
      mimeType: "application/sql",
      fileExtension: "sql",
      rowCount: 1,
      columnCount: 1,
    });
    const state = useDataGridExport(options);

    expect(state.canCopyWithExtractor("sql-updates")).toBe(true);
    await state.copyWithExtractor("sql-updates");

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        extractor: "sql-updates",
        selectedColumnIndexes: [0],
        rows: [[true, 7]],
        selectionKind: "cells",
      }),
    );
    expect(copyToClipboard).toHaveBeenCalledWith("UPDATE users SET active = TRUE WHERE id = 7;");
  });

  it("preserves drag-reordered visible column order when copying", async () => {
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "x", mimeType: "text/csv", fileExtension: "csv", rowCount: 1, columnCount: 3 });
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [0, 1, 2],
      columns: ["id", "name", "note"],
      rows: [[1, "Ada", "x"]],
    };
    // User dragged columns into note, id, name order (source indexes 2, 0, 1).
    const state = createExportState(editableTable, ["id", "name", "note"], matrix, undefined, undefined, undefined, [], DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, false, [2, 0, 1]);
    await state.copyWithExtractor("csv");

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ displayName: "note" }), expect.objectContaining({ displayName: "id" }), expect.objectContaining({ displayName: "name" })],
      }),
    );
  });

  it("excludes hidden columns and keeps visible order when copying", async () => {
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "x", mimeType: "text/csv", fileExtension: "csv", rowCount: 1, columnCount: 2 });
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [0, 1],
      columns: ["note", "id"],
      rows: [["x", 1]],
    };
    // Columns id/name/note; "name" is hidden, so visible order is note, id (source 2, 0).
    const state = createExportState(editableTable, ["id", "name", "note"], matrix, undefined, undefined, undefined, [], DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, false, [2, 0]);
    await state.copyWithExtractor("csv");

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ displayName: "note" }), expect.objectContaining({ displayName: "id" })],
      }),
    );
  });

  it("copies the full row when right-clicking a cell with a synthetic single-cell selection", async () => {
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "x", mimeType: "text/csv", fileExtension: "csv", rowCount: 1, columnCount: 3 });
    // A synthetic 1×1 selection (what right-click creates) — only column 0 of row 0.
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [0],
      columns: ["id"],
      rows: [[1]],
    };
    const state = createExportState(editableTable, ["id", "name", "note"], matrix, undefined, undefined, undefined, [], DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, false, [0, 1, 2], true);
    await state.copyWithExtractor("csv");

    // Despite the 1×1 matrix, the context-cell fallback should produce a full-row request (3 columns).
    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ displayName: "id" }), expect.objectContaining({ displayName: "name" }), expect.objectContaining({ displayName: "note" })],
      }),
    );
  });

  it("copies only the selected cell for a genuine 1×1 selection (not synthetic)", async () => {
    vi.mocked(extractDataGridSelection).mockResolvedValue({ text: "x", mimeType: "text/csv", fileExtension: "csv", rowCount: 1, columnCount: 1 });
    // A genuine 1×1 selection (user Ctrl+click) — column 1 of row 0.
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["name"],
      rows: [["Ada"]],
    };
    // isSyntheticContext = false → should NOT use the context-cell full-row fallback.
    const state = createExportState(editableTable, ["id", "name", "note"], matrix, undefined, undefined, undefined, [], DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, false, [0, 1, 2], false);
    await state.copyWithExtractor("csv");

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ displayName: "name" })],
      }),
    );
  });

  it("preserves the effective row-header TSV matrix across copy and paste", async () => {
    const rows = [
      [1, null],
      [2, "inside\ttab\nnext line"],
    ];
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0, 1],
      columnIndexes: [0, 1],
      columns: ["id", "name"],
      rows,
    };
    const extractorOptions = {
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      dsv: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv, includeColumnHeader: true, includeRowHeader: true },
    };
    const text = '#\tid\tname\n1\t1\tNULL\n2\t2\t"inside\ttab\nnext line"';
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({ text, mimeType: "text/tab-separated-values", fileExtension: "tsv", rowCount: 2, columnCount: 3 });
    const state = createExportState(editableTable, ["id", "name"], matrix, undefined, undefined, rows, [], extractorOptions);

    await expect(state.copyWithExtractor("tsv-with-headers")).resolves.toBe(true);

    expect(parseDataGridClipboard(text)).toEqual([
      ["#", "id", "name"],
      ["1", "1", null],
      ["2", "2", "inside\ttab\nnext line"],
    ]);
  });

  it("rejects SQL UPDATE when the selection contains no writable non-key column", () => {
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [0],
      columns: ["id"],
      rows: [[1]],
    };
    const state = createExportState(editableTable, ["id", "name"], matrix);

    expect(state.canCopyWithExtractor("sql-updates")).toBe(false);
  });

  it("rejects SQL UPDATE when the only selected value is generated", () => {
    const tableMeta: DataGridTableMeta = {
      tableName: "users",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
        { name: "search_text", data_type: "text", is_nullable: true, extra: "GENERATED ALWAYS AS" },
      ],
    };
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["search_text"],
      rows: [["generated"]],
    };
    const state = createExportState(tableMeta, ["id", "search_text"], matrix, [1, "generated"]);

    expect(state.canCopyWithExtractor("sql-updates")).toBe(false);
  });

  it("allows a computed SQL UPDATE only after the user disables computed-column skipping", () => {
    const tableMeta: DataGridTableMeta = {
      tableName: "users",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
        { name: "search_text", data_type: "text", is_nullable: true, extra: "GENERATED ALWAYS AS" },
      ],
    };
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["search_text"],
      rows: [["generated"]],
    };
    const extractorOptions = {
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, skipComputedColumns: false },
    };
    const state = createExportState(tableMeta, ["id", "search_text"], matrix, [1, "generated"], undefined, undefined, [], extractorOptions);

    expect(state.canCopyWithExtractor("sql-updates")).toBe(true);
  });

  it("uses current SQL options when deciding whether INSERT is available", () => {
    const computedTable: DataGridTableMeta = {
      tableName: "users",
      primaryKeys: [],
      columns: [{ name: "search_text", data_type: "text", is_nullable: true, extra: "GENERATED ALWAYS AS" }],
    };
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [0], columns: ["search_text"], rows: [["generated"]] };
    const includeComputed = {
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, skipComputedColumns: false },
    };

    expect(createExportState(computedTable, ["search_text"], matrix).canCopyWithExtractor("sql-inserts")).toBe(false);
    expect(createExportState(computedTable, ["search_text"], matrix, undefined, undefined, undefined, [], includeComputed).canCopyWithExtractor("sql-inserts")).toBe(true);
  });

  it("disables INSERT when primary-key exclusion removes every selected column", () => {
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [0], columns: ["id"], rows: [[1]] };
    const excludePrimaryKeys = {
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, skipGeneratedColumns: false, excludePrimaryKeysFromInsert: true },
    };

    const state = createExportState(editableTable, ["id"], matrix, [1], undefined, undefined, [], excludePrimaryKeys);

    expect(state.canCopyWithExtractor("sql-inserts")).toBe(false);
  });

  it("keeps an auto-increment primary key when copying only the primary key column as INSERT", () => {
    const autoIncrementTable: DataGridTableMeta = {
      tableName: "users",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_nullable: false, is_primary_key: true, extra: "auto_increment" },
        { name: "name", data_type: "varchar", is_nullable: false },
      ],
    };
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [0], columns: ["id"], rows: [[1]] };

    const state = createExportState(autoIncrementTable, ["id", "name"], matrix);

    expect(state.canCopyWithExtractor("sql-inserts")).toBe(true);
  });

  it("sends only selected values for non-SQL extraction and marks column selections", async () => {
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [1], columns: ["name"], rows: [["Ada"]] };
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: '[{"name":"Ada"}]',
      mimeType: "application/json",
      fileExtension: "json",
      rowCount: 1,
      columnCount: 1,
    });
    const state = createExportState(editableTable, ["id", "name"], matrix, [7, "Ada"], undefined, undefined, [], DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, true);

    await state.copyWithExtractor("json");

    const request = vi.mocked(extractDataGridSelection).mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        columns: [{ displayName: "name", sourceName: "name", sourceIndex: 0 }],
        selectedColumnIndexes: [0],
        rows: [["Ada"]],
        selectionKind: "columns",
      }),
    );
    expect(request?.databaseType).toBeUndefined();
    expect(request?.tableMeta).toBeUndefined();
  });

  it("surfaces extractor warnings after copying", async () => {
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [0], columns: ["id"], rows: [[1]] };
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: "1",
      mimeType: "text/plain",
      fileExtension: "txt",
      rowCount: 1,
      columnCount: 1,
      warnings: [{ code: "omitted-columns", message: "backend text" }],
    });
    const state = createExportState(editableTable, ["id"], matrix, [1]);

    await state.copyWithExtractor("pretty");

    expect(toast).toHaveBeenCalledWith("grid.copyExtractorWarningOmittedColumns", 5000);
  });

  it("reports extractor copy failure without presenting post-copy warnings", async () => {
    const matrix: CellSelectionMatrix = { rowIndexes: [0], columnIndexes: [0], columns: ["id"], rows: [[1]] };
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: "1",
      mimeType: "text/plain",
      fileExtension: "txt",
      rowCount: 1,
      columnCount: 1,
      warnings: [{ code: "omitted-columns", message: "backend text" }],
    });
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("clipboard unavailable"));
    const state = createExportState(editableTable, ["id"], matrix, [1]);

    await expect(state.copyWithExtractor("pretty")).resolves.toBe(false);

    expect(toast).toHaveBeenCalledWith("grid.copyFailed: clipboard unavailable", 5000);
    expect(toast).not.toHaveBeenCalledWith("grid.copyExtractorWarningOmittedColumns", 5000);
  });

  it("rejects irregular discrete cell selections before building an extractor request", async () => {
    const state = createExportState(editableTable, ["id", "name"], undefined, undefined, {
      columns: ["id", "name"],
      rows: [[1], ["Grace"]],
    });

    expect(state.canCopyWithExtractor("json")).toBe(false);
    await expect(state.copyWithExtractor("json")).resolves.toBe(false);
    expect(extractDataGridSelection).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("grid.copyExtractorUnsupportedSelection", 5000);
  });

  it("limits live extractor previews to the first 100 selected rows", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => [index + 1, `name-${index + 1}`]);
    const matrix: CellSelectionMatrix = {
      rowIndexes: rows.map((_, index) => index),
      columnIndexes: [0, 1],
      columns: ["id", "name"],
      rows,
    };
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: "preview",
      mimeType: "text/csv",
      fileExtension: "csv",
      rowCount: 100,
      columnCount: 2,
    });
    const state = createExportState(editableTable, ["id", "name"], matrix, undefined, undefined, rows);

    const preview = await state.previewWithExtractor("csv", DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);

    expect(vi.mocked(extractDataGridSelection).mock.calls[0]?.[0].rows).toHaveLength(100);
    expect(preview).toEqual(expect.objectContaining({ sourceRowCount: 101, truncated: true }));
  });

  it("builds row extractor requests from selected row ids in display order", async () => {
    vi.mocked(extractDataGridSelection).mockResolvedValueOnce({
      text: '[{"id":1,"name":"Ada"},{"id":3,"name":"Linus"}]',
      mimeType: "application/json",
      fileExtension: "json",
      rowCount: 2,
      columnCount: 2,
    });
    const state = createExportState(
      editableTable,
      ["id", "name"],
      undefined,
      undefined,
      undefined,
      [
        [1, "Ada"],
        [2, "Grace"],
        [3, "Linus"],
      ],
      [3, 1],
    );

    await expect(state.copyWithExtractor("json")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        extractor: "json",
        selectedColumnIndexes: [0, 1],
        rows: [
          [1, "Ada"],
          [3, "Linus"],
        ],
        selectionKind: "rows",
      }),
    );
  });

  it("keeps JSON cells structured in JSON and SQL extractor requests", async () => {
    const tableMeta: DataGridTableMeta = {
      tableName: "events",
      primaryKeys: ["id"],
      columns: [
        { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
        { name: "payload", data_type: "json", is_nullable: true },
      ],
    };
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [0, 1],
      columns: ["id", "payload"],
      rows: [[7, '{"name":"Ada","tags":["admin"]}']],
    };
    vi.mocked(extractDataGridSelection).mockResolvedValue({
      text: "copied",
      mimeType: "application/json",
      fileExtension: "json",
      rowCount: 1,
      columnCount: 2,
    });
    const state = createExportState(tableMeta, ["id", "payload"], matrix, [7, '{"name":"Ada","tags":["admin"]}']);

    await expect(state.copyWithExtractor("json")).resolves.toBe(true);
    await expect(state.copyWithExtractor("sql-inserts")).resolves.toBe(true);

    expect(extractDataGridSelection).toHaveBeenNthCalledWith(1, expect.objectContaining({ rows: [[7, { name: "Ada", tags: ["admin"] }]] }));
    expect(extractDataGridSelection).toHaveBeenNthCalledWith(2, expect.objectContaining({ rows: [[7, { name: "Ada", tags: ["admin"] }]] }));
  });

  it("rejects SQL UPDATE instead of silently skipping a row with a null primary key", async () => {
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["name"],
      rows: [["Ada"]],
    };
    const state = createExportState(editableTable, ["id", "name"], matrix, [null, "Ada"]);

    expect(state.canCopyWithExtractor("sql-updates")).toBe(false);
    await expect(state.copyWithExtractor("sql-updates")).resolves.toBe(false);
    expect(buildDataGridCopyUpdateStatements).not.toHaveBeenCalled();
  });

  it("copies Mongo JSON from the original document using the sorted source index and visible columns", async () => {
    const item = { ...row(["true", '{"role":"admin"}']), sourceIndex: 1 };
    const state = createMongoExportState({
      columns: ["booleanText", "profile"],
      item,
      mongoDocuments: [
        { booleanText: "wrong row", profile: { role: "viewer" } },
        { booleanText: "true", profile: { role: "admin" }, hidden: "not selected" },
      ],
    });

    await state.copyRow();

    expect(copyToClipboard).toHaveBeenCalledWith(JSON.stringify({ booleanText: "true", profile: { role: "admin" } }, null, 2));
  });

  it("uses the Mongo insert formatter for extractor copy and preview", async () => {
    const item = { ...row(["123", "true"]), sourceIndex: 0 };
    const state = createMongoExportState({
      columns: ["numericText", "booleanText"],
      item,
      mongoDocuments: [{ numericText: "123", booleanText: "true" }],
      selectedCellMatrix: {
        rowIndexes: [0],
        columnIndexes: [1],
        columns: ["booleanText"],
        rows: [["true"]],
      },
    });

    await expect(state.copyWithExtractor("sql-inserts")).resolves.toBe(true);
    const preview = await state.previewWithExtractor("sql-inserts", DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);

    expect(copyToClipboard).toHaveBeenCalledWith(`db.getCollection("documents").insert({
  "booleanText": "true"
});`);
    expect(preview).toEqual(
      expect.objectContaining({
        text: `db.getCollection("documents").insert({
  "booleanText": "true"
});`,
        rowCount: 1,
        sourceRowCount: 1,
        truncated: false,
      }),
    );
    expect(extractDataGridSelection).not.toHaveBeenCalled();
  });
});
