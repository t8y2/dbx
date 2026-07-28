import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { buildDataGridCopyInsertStatement, buildDataGridCopyUpdateStatements } from "@/lib/dataGrid/dataGridSql";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import type { CellSelectionMatrix } from "@/lib/dataGrid/gridSelection";

const toast = vi.fn();

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: { message?: string }) => (params?.message ? `${key}: ${params.message}` : key) }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/dataGrid/dataGridSql", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dataGrid/dataGridSql")>();
  return {
    ...original,
    buildDataGridCopyInsertStatement: vi.fn(),
    buildDataGridCopyUpdateStatements: vi.fn(),
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    getRowItem: (rowId) => items.find((item) => item.id === rowId),
    selectedRowIds: ref(selectedRowIds),
    hasRowSelection: computed(() => selectedRowIds.size > 0),
  };
  return useDataGridExport(state);
}

function createExportState(tableMeta: DataGridTableMeta, columns = tableMeta.columns?.map((column) => column.name) ?? ["id", "name"], selectedCellMatrix?: CellSelectionMatrix) {
  const item = row(columns.map((column, index) => (column === "id" ? 1 : `value-${index}`)));
  const options: UseDataGridExportOptions = {
    columns: computed(() => columns),
    displayItems: computed(() => [item]),
    sql: computed(() => undefined),
    tableMeta: computed(() => tableMeta),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "dbx"),
    context: computed(() => "table-data"),
    sourceColumns: computed(() => columns),
    columnTypes: computed(() => columns.map(() => "varchar")),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => !!selectedCellMatrix),
    selectedCells: computed(() => selectedCellMatrix ?? { columns: [], rows: [] }),
    selectedCellMatrix: computed(() => selectedCellMatrix ?? null),
    selectedRange: computed(() => null),
    contextCell: ref({ rowId: item.id, rowIndex: 0, col: -1 }),
    getRowItem: (rowId) => (rowId === item.id ? item : undefined),
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
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
  });

  it("reuses an in-flight INSERT prefetch when the copy action runs", async () => {
    const pending = deferred<string | undefined>();
    vi.mocked(buildDataGridCopyInsertStatement).mockReturnValueOnce(pending.promise);
    const state = createExportState(editableTable);

    const prefetch = state.prefetchRowAsInsertStatement(false);
    const copy = state.copyRowAsInsert();
    await vi.waitFor(() => expect(buildDataGridCopyInsertStatement).toHaveBeenCalledTimes(1));
    pending.resolve("INSERT INTO users VALUES (1, 'Alice');");

    await Promise.all([prefetch, copy]);
    expect(copyToClipboard).toHaveBeenCalledWith("INSERT INTO users VALUES (1, 'Alice');");
  });

  it("reuses an in-flight UPDATE prefetch on the first copy action", async () => {
    const pending = deferred<string[]>();
    vi.mocked(buildDataGridCopyUpdateStatements).mockReturnValueOnce(pending.promise);
    const state = createExportState(editableTable);

    const prefetch = state.prefetchRowAsUpdateStatement();
    const copy = state.copyRowAsUpdate();
    await vi.waitFor(() => expect(buildDataGridCopyUpdateStatements).toHaveBeenCalledTimes(1));
    pending.resolve(["UPDATE users SET name = 'Alice' WHERE id = 1;"]);

    await Promise.all([prefetch, copy]);
    expect(copyToClipboard).toHaveBeenCalledWith("UPDATE users SET name = 'Alice' WHERE id = 1;");
  });

  it.each(["GENERATED ALWAYS AS (1)", "IDENTITY(1, 1)"])("disables copy-as-insert when every result column is non-insertable (%s)", (extra) => {
    const state = createExportState(
      {
        tableName: "generated_values",
        primaryKeys: [],
        columns: [{ name: "computed_value", data_type: "int", is_nullable: true, extra }],
      },
      ["computed_value"],
    );

    expect(state.canCopyRowAsInsert.value).toBe(false);
  });

  it("reports a shared builder failure when the user invokes copy", async () => {
    const pending = deferred<string | undefined>();
    vi.mocked(buildDataGridCopyInsertStatement).mockReturnValueOnce(pending.promise);
    const state = createExportState(editableTable);

    const prefetch = state.prefetchRowAsInsertStatement(false);
    const copy = state.copyRowAsInsert();
    await vi.waitFor(() => expect(buildDataGridCopyInsertStatement).toHaveBeenCalledTimes(1));
    pending.reject(new Error("builder unavailable"));

    await Promise.all([prefetch, copy]);
    expect(toast).toHaveBeenCalledWith("grid.copyFailed: builder unavailable", 5000);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("reports an UPDATE builder failure from the first copy action", async () => {
    const pending = deferred<string[]>();
    vi.mocked(buildDataGridCopyUpdateStatements).mockReturnValueOnce(pending.promise);
    const state = createExportState(editableTable);

    const prefetch = state.prefetchRowAsUpdateStatement();
    const copy = state.copyRowAsUpdate();
    await vi.waitFor(() => expect(buildDataGridCopyUpdateStatements).toHaveBeenCalledTimes(1));
    pending.reject(new Error("update builder unavailable"));

    await Promise.all([prefetch, copy]);
    expect(toast).toHaveBeenCalledWith("grid.copyFailed: update builder unavailable", 5000);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("reports selection INSERT prefetch failures", async () => {
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0],
      columnIndexes: [1],
      columns: ["name"],
      rows: [["value-1"]],
    };
    vi.mocked(buildDataGridCopyInsertStatement).mockRejectedValueOnce(new Error("selection builder unavailable"));
    const state = createExportState(editableTable, ["id", "name"], matrix);

    await state.prefetchSelectionAsInsertStatement();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("grid.copyFailed: selection builder unavailable", 5000);
    expect(state.canCopyPreparedSelectionInsert()).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("builds selection INSERT statements from only the selected source columns and rows", async () => {
    const items = [
      { ...row([1, "Ada", true, "math"]), id: 1 },
      { ...row([2, "Grace", false, "compiler"]), id: 2 },
    ];
    const matrix: CellSelectionMatrix = {
      rowIndexes: [0, 1],
      columnIndexes: [1, 3],
      columns: ["display_name", "display_note"],
      rows: [
        ["Ada", "math"],
        ["Grace", "compiler"],
      ],
    };
    const options: UseDataGridExportOptions = {
      columns: computed(() => ["id", "display_name", "active", "display_note"]),
      displayItems: computed(() => items),
      sql: computed(() => undefined),
      tableMeta: computed(() => ({
        tableName: "users",
        primaryKeys: ["id"],
        columns: [
          { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
          { name: "name", data_type: "varchar", is_nullable: false },
          { name: "active", data_type: "boolean", is_nullable: false },
          { name: "note", data_type: "text", is_nullable: true },
        ],
      })),
      databaseType: computed(() => "mysql"),
      connectionId: computed(() => "connection-1"),
      database: computed(() => "dbx"),
      context: computed(() => "table-data"),
      sourceColumns: computed(() => ["id", "name", "active", "note"]),
      columnTypes: computed(() => ["int", "varchar", "boolean", "text"]),
      whereInput: computed(() => undefined),
      orderBy: computed(() => undefined),
      exportBatchSize: computed(() => 1000),
      hasCellSelection: computed(() => true),
      selectedCells: computed(() => matrix),
      selectedCellMatrix: computed(() => matrix),
      selectedRange: computed(() => ({ startRow: 0, endRow: 1, startCol: 1, endCol: 3 })),
      contextCell: ref({ rowId: 1, rowIndex: 0, col: 1 }),
      getRowItem: (rowId) => items.find((item) => item.id === rowId),
      selectedRowIds: ref(new Set<number>()),
      hasRowSelection: computed(() => false),
    };
    const pending = deferred<string | undefined>();
    vi.mocked(buildDataGridCopyInsertStatement).mockReturnValueOnce(pending.promise);
    const state = useDataGridExport(options);

    const copy = state.copySelectionAsInsert("merged");
    await vi.waitFor(() => expect(buildDataGridCopyInsertStatement).toHaveBeenCalledTimes(1));
    expect(copyToClipboard).not.toHaveBeenCalled();
    pending.resolve("INSERT INTO users (name, note) VALUES ('Ada', 'math'), ('Grace', 'compiler');");
    await copy;
    expect(state.canCopyPreparedSelectionInsert("merged")).toBe(true);

    expect(buildDataGridCopyInsertStatement).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: ["display_name", "display_note"],
        sourceColumns: ["name", "note"],
        columnTypes: ["varchar", "text"],
        rows: [
          ["Ada", "math"],
          ["Grace", "compiler"],
        ],
        excludePrimaryKeys: false,
        insertMode: "merged",
      }),
    );
    expect(copyToClipboard).toHaveBeenCalledWith("INSERT INTO users (name, note) VALUES ('Ada', 'math'), ('Grace', 'compiler');");
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

  it("preserves original Mongo string types in INSERT and applies explicit edits", async () => {
    const item = { ...row(["123", "true", '{"kind":"literal"}', "2024-01-01 00:00:00", '{"role":"maintainer"}', 'ISODate("2025-05-06T08:35:32Z")']), sourceIndex: 0 };
    item.isDirtyCol = [false, false, false, false, true, false];
    const state = createMongoExportState({
      columns: ["numericText", "booleanText", "jsonText", "dateText", "profile", "lastUpdatedDate"],
      item,
      mongoDocuments: [
        {
          numericText: "123",
          booleanText: "true",
          jsonText: '{"kind":"literal"}',
          dateText: "2024-01-01 00:00:00",
          profile: { role: "admin" },
          lastUpdatedDate: { $date: "2025-05-06T08:35:32Z" },
        },
      ],
    });

    await state.copyRowAsInsert();

    expect(copyToClipboard).toHaveBeenCalledWith(`db.getCollection("documents").insert({
  "numericText": "123",
  "booleanText": "true",
  "jsonText": "{\\"kind\\":\\"literal\\"}",
  "dateText": "2024-01-01 00:00:00",
  "profile": {
    "role": "maintainer"
  },
  "lastUpdatedDate": ISODate("2025-05-06T08:35:32Z")
});`);
  });

  it("copies a Mongo row as updateOne while preserving BSON types and missing fields", async () => {
    const item = {
      ...row(["507f1f77bcf86cd799439011", "123", 'NumberLong("9007199254740993")', null, null, '{"role":"maintainer"}', "12.34", "AQI="]),
      sourceIndex: 0,
    };
    item.isDirtyCol = [false, false, false, false, false, true, false, false];
    const state = createMongoExportState({
      columns: ["_id", "numericText", "counter", "nullable", "missing", "profile", "decimal", "payload"],
      item,
      mongoDocuments: [
        {
          _id: { $oid: "507f1f77bcf86cd799439011" },
          numericText: "123",
          counter: { $numberLong: "9007199254740993" },
          nullable: null,
          profile: { role: "admin" },
          decimal: { $numberDecimal: "12.34" },
          payload: { $binary: { base64: "AQI=", subType: "00" } },
        },
      ],
    });

    expect(state.canCopyRowAsUpdate.value).toBe(true);
    await state.copyRowAsUpdate();

    expect(buildDataGridCopyUpdateStatements).not.toHaveBeenCalled();
    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0] ?? "";
    expect(copied).toContain('db.getCollection("documents")');
    expect(copied).toContain(".updateOne(");
    expect(copied).toContain('"_id": ObjectId("507f1f77bcf86cd799439011")');
    expect(copied).toContain('"numericText": "123"');
    expect(copied).toContain('"counter": NumberLong("9007199254740993")');
    expect(copied).toContain('"nullable": null');
    expect(copied).toContain('"profile":');
    expect(copied).toContain('"role": "maintainer"');
    expect(copied).toContain('"decimal": EJSON.deserialize(');
    expect(copied).toContain('"$numberDecimal": "12.34"');
    expect(copied).toContain('"payload": EJSON.deserialize(');
    expect(copied).toContain('"$binary":');
    expect(copied).toContain('"$unset":');
    expect(copied).toContain('"missing": ""');
  });

  it("does not expose Mongo UPDATE copy without an explicit data-list target", async () => {
    const item = { ...row(["507f1f77bcf86cd799439011", "Alice"]), sourceIndex: 0 };
    const state = createMongoExportState({
      columns: ["_id", "name"],
      item,
      mongoDocuments: [{ _id: { $oid: "507f1f77bcf86cd799439011" }, name: "Alice" }],
      mongoUpdateTarget: false,
    });

    expect(state.canCopyRowAsUpdate.value).toBe(false);
    await state.copyRowAsUpdate();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("copies selected Mongo rows as separate updates using each sorted source document", async () => {
    const first = { ...row(["second-id", "Second"]), id: 1, sourceIndex: 1 };
    const second = { ...row(["first-id", "First"]), id: 2, sourceIndex: 0 };
    const state = createMongoExportState({
      columns: ["_id", "name"],
      item: first,
      items: [first, second],
      mongoDocuments: [
        { _id: "first-id", name: "First" },
        { _id: "second-id", name: "Second" },
      ],
      selectedRowIds: new Set([1, 2]),
    });

    await state.copyRowAsUpdate();

    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0] ?? "";
    expect(copied.match(/\.updateOne\(/g)).toHaveLength(2);
    expect(copied.indexOf('"_id": "second-id"')).toBeLessThan(copied.indexOf('"_id": "first-id"'));
  });

  it("preserves original Mongo types while limiting INSERT to the selected fields", async () => {
    const item = { ...row(["123", "true", '{"kind":"literal"}']), sourceIndex: 0 };
    const state = createMongoExportState({
      columns: ["numericText", "booleanText", "jsonText"],
      item,
      mongoDocuments: [{ numericText: "123", booleanText: "true", jsonText: '{"kind":"literal"}' }],
      selectedCellMatrix: {
        rowIndexes: [0],
        columnIndexes: [1],
        columns: ["booleanText"],
        rows: [["true"]],
      },
    });

    await state.copySelectionAsInsert();

    expect(copyToClipboard).toHaveBeenCalledWith(`db.getCollection("documents").insert({
  "booleanText": "true"
});`);
  });

  it("does not traverse Mongo documents while checking copy availability", async () => {
    let documentReads = 0;
    const originalDocument = Object.defineProperty({}, "payload", {
      enumerable: true,
      get() {
        documentReads++;
        return "large-value";
      },
    });
    const item = { ...row(["large-value"]), sourceIndex: 0 };
    const state = createMongoExportState({ columns: ["payload"], item, mongoDocuments: [originalDocument] });

    expect(state.canCopyRowAsInsert.value).toBe(true);
    expect(documentReads).toBe(0);

    const copy = state.copyRowAsInsert();
    expect(documentReads).toBe(0);
    expect(copyToClipboard).not.toHaveBeenCalled();

    await copy;
    expect(documentReads).toBeGreaterThan(0);
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('"payload": "large-value"'));
  });

  it("preserves oversized Mongo documents without running the formatter", async () => {
    const payload = "x".repeat(1_100_000);
    const item = { ...row([payload]), sourceIndex: 0 };
    const state = createMongoExportState({ columns: ["payload"], item, mongoDocuments: [{ payload }] });

    await state.copyRowAsInsert();

    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0] ?? "";
    expect(copied).toHaveLength(payload.length + 'db.getCollection("documents").insert({"payload":""});'.length);
    expect(copied.startsWith('db.getCollection("documents").insert({"payload":"')).toBe(true);
    expect(copied.endsWith('"});')).toBe(true);
  });
});
