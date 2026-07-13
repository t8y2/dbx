import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { buildDataGridCopyInsertStatement, buildDataGridCopyUpdateStatements } from "@/lib/dataGrid/dataGridSql";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";

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

function createMongoExportState(options: { columns: string[]; item: ReturnType<typeof row> & { sourceIndex: number }; mongoDocuments: unknown[] }) {
  const state: UseDataGridExportOptions = {
    columns: computed(() => options.columns),
    displayItems: computed(() => [options.item]),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    copyInsertTargetLabel: computed(() => "documents"),
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
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell: ref({ rowId: options.item.id, rowIndex: 0, col: -1 }),
    getRowItem: (rowId) => (rowId === options.item.id ? options.item : undefined),
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
  };
  return useDataGridExport(state);
}

function createExportState(tableMeta: DataGridTableMeta, columns = tableMeta.columns?.map((column) => column.name) ?? ["id", "name"]) {
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
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
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
    const item = { ...row(["123", "true", '{"kind":"literal"}', "2024-01-01 00:00:00", '{"role":"maintainer"}']), sourceIndex: 0 };
    item.isDirtyCol = [false, false, false, false, true];
    const state = createMongoExportState({
      columns: ["numericText", "booleanText", "jsonText", "dateText", "profile"],
      item,
      mongoDocuments: [
        {
          numericText: "123",
          booleanText: "true",
          jsonText: '{"kind":"literal"}',
          dateText: "2024-01-01 00:00:00",
          profile: { role: "admin" },
        },
      ],
    });

    await state.copyRowAsInsert();

    expect(copyToClipboard).toHaveBeenCalledWith('db.getCollection("documents").insert({"numericText":"123","booleanText":"true","jsonText":"{\\"kind\\":\\"literal\\"}","dateText":"2024-01-01 00:00:00","profile":{"role":"maintainer"}});');
  });
});
