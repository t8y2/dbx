import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import type { DatabaseType } from "@/types/database";
import { MONGO_DOCUMENT_GRID_NULL, mongoDocumentGridDisplayText, mongoDocumentGridEditorText, mongoDocumentGridExternalValue, mongoDocumentGridValue } from "@/lib/mongo/mongoDocumentValues";
import exactDecimalWire from "@/lib/__tests__/dataGrid/fixtures/exactDecimalQueryResult.json";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ extractDataGridSelection: mocks.extract }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function createState(
  databaseType: DatabaseType,
  tableMeta: DataGridTableMeta | undefined,
  extractorOptions?: DataGridExtractorOptions,
  includeDatabaseName = false,
  query?: { columns: string[]; values: unknown[]; visible: number[]; types: string[]; omitFullTypes?: boolean },
  overrides: Partial<Parameters<typeof useDataGridExtractor>[0]> = {},
) {
  const allColumns = query?.columns ?? ["id", "name"];
  const visible = query?.visible ?? [0, 1];
  const items = [{ id: 1, data: query?.values ?? [1, "Ada"], isDraft: false }];
  return useDataGridExtractor({
    columns: computed(() => visible.map((index) => allColumns[index]!)),
    allColumns: computed(() => allColumns),
    displayItems: computed(() => items),
    allDisplayItems: computed(() => items),
    allSourceColumns: computed(() => undefined),
    visibleColumnIndexes: computed(() => visible),
    columnTypes: computed(() => query && visible.map((index) => query.types[index])),
    allColumnTypes: query?.omitFullTypes ? undefined : computed(() => query?.types),
    extractorOptions: computed(() => extractorOptions ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS),
    databaseType: computed(() => databaseType),
    identifierQuote: computed(() => undefined),
    tableMeta: computed(() => tableMeta),
    includeDatabaseName: computed(() => includeDatabaseName),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedCellMatrix: computed(() => null),
    hasRowSelection: computed(() => true),
    hasColumnSelection: computed(() => false),
    selectedRowIds: ref(new Set<number>([1])),
    contextCell: ref(null),
    contextSelectionIsSynthetic: ref(false),
    copyText: vi.fn(async () => true),
    canCopySqlInsert: () => true,
    buildMongoInsert: vi.fn(async () => undefined),
    ...overrides,
  });
}

function qualifiedMeta(schema?: string, database?: string): DataGridTableMeta {
  return {
    tableName: "users",
    schema,
    database,
    primaryKeys: ["id"],
    columns: [
      { name: "id", data_type: "int" },
      { name: "name", data_type: "varchar" },
    ],
  };
}

async function capturedRequest(databaseType: DatabaseType, tableMeta: DataGridTableMeta, extractorOptions?: DataGridExtractorOptions, includeDatabaseName = false) {
  const state = createState(databaseType, tableMeta, extractorOptions, includeDatabaseName);
  const extraction = await state.extractWithExtractor("sql-inserts");
  expect(extraction).not.toBeNull();
  return mocks.extract.mock.calls[mocks.extract.mock.calls.length - 1]![0]!;
}

describe("useDataGridExtractor includeDatabaseName payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extract.mockResolvedValue({ text: "INSERT INTO users VALUES (1, 'Ada');", rowCount: 1 });
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("passes %s into PHP extraction for dialect-specific float semantics", async (databaseType) => {
    const state = createState(databaseType, undefined);
    await state.extractWithExtractor("php");
    const request = mocks.extract.mock.calls.at(-1)![0];
    expect(request.databaseType).toBe(databaseType);
    expect(request.options.php).toMatchObject({ formatDateIso: true });
    expect(request.options.php).not.toHaveProperty("formatDateISO");
  });

  it.each([
    ["sqlserver", "dbo", "app"],
    ["snowflake", "PUBLIC", undefined],
  ] as const)("keeps the namespace flag true for %s even when the option is off", async (databaseType, schema, database) => {
    const request = await capturedRequest(databaseType, qualifiedMeta(schema, database));
    expect(request.tableMeta.schema).toBe(schema);
    expect(request.options.sql.includeDatabaseName).toBe(true);
  });

  it("keeps optional qualifiers and sets the flag on by default for MySQL", async () => {
    const request = await capturedRequest("mysql", qualifiedMeta(undefined, "mydb"));
    expect(request.tableMeta.database).toBe("mydb");
    expect(request.options.sql.includeDatabaseName).toBe(true);
  });

  it("strips optional qualifiers when explicitly opted out", async () => {
    const request = await capturedRequest("mysql", qualifiedMeta(undefined, "mydb"), { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, includeDatabaseName: false } });
    expect(request.tableMeta.database).toBeUndefined();
    expect(request.tableMeta.schema).toBeUndefined();
    expect(request.options.sql.includeDatabaseName).toBe(false);
  });

  it("falls back to option database when tableMeta database is missing", async () => {
    const allColumns = ["id", "name"];
    const items = [{ id: 1, data: [1, "Ada"], isDraft: false }];
    const state = useDataGridExtractor({
      columns: computed(() => allColumns),
      allColumns: computed(() => allColumns),
      displayItems: computed(() => items),
      allDisplayItems: computed(() => items),
      allSourceColumns: computed(() => undefined),
      visibleColumnIndexes: computed(() => [0, 1]),
      columnTypes: computed(() => ["int", "varchar"]),
      extractorOptions: computed(() => DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS),
      databaseType: computed(() => "mysql"),
      identifierQuote: computed(() => undefined),
      tableMeta: computed(() => ({ tableName: "users", primaryKeys: ["id"], columns: [{ name: "id" }, { name: "name" }] })),
      database: computed(() => "appdb"),
      hasCellSelection: computed(() => false),
      selectedCells: computed(() => ({ columns: [], rows: [] })),
      selectedCellMatrix: computed(() => null),
      hasRowSelection: computed(() => true),
      hasColumnSelection: computed(() => false),
      selectedRowIds: ref(new Set<number>([1])),
      contextCell: ref(null),
      contextSelectionIsSynthetic: ref(false),
      copyText: vi.fn(async () => true),
      canCopySqlInsert: () => true,
      buildMongoInsert: vi.fn(async () => undefined),
    });
    const extraction = await state.extractWithExtractor("sql-inserts");
    expect(extraction).not.toBeNull();
    const req = mocks.extract.mock.calls.at(-1)![0];
    expect(req.tableMeta.database).toBe("appdb");
  });

  it("passes real query types for reordered and hidden row columns without table metadata", async () => {
    const values = ["2026-10-10 13:14:15", "2026-10-10 13:14:15.123456", "2026-10-10 13:14:15.123456 -5:30", null];
    const state = createState("oceanbase-oracle", undefined, undefined, false, {
      columns: ["D", "T", "Z", "N"],
      values,
      visible: [2, 0],
      types: ["DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "VARCHAR2"],
    });
    expect(await state.extractWithExtractor("sql-inserts")).not.toBeNull();
    const request = mocks.extract.mock.calls.at(-1)![0];
    expect(request.tableMeta).toBeUndefined();
    expect(request.columns.map((column: { sourceName: string; dataType: string }) => [column.sourceName, column.dataType])).toEqual([
      ["Z", "TIMESTAMP WITH TIME ZONE"],
      ["D", "DATE"],
    ]);
    expect(request.rows).toEqual([[values[2], values[0]]]);
    expect(await state.extractWithExtractor("sql-select")).not.toBeNull();
    const fullRequest = mocks.extract.mock.calls.at(-1)![0];
    expect(fullRequest.columns.map((column: { dataType: string }) => column.dataType)).toEqual(["DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "VARCHAR2"]);
    expect(fullRequest.rows).toEqual([values]);
  });

  it("keeps exact-decimal wire strings through native, editor, and raw pasteback paths", async () => {
    const wire = JSON.parse(JSON.stringify(exactDecimalWire)) as { columns: string[]; column_types: string[]; rows: unknown[][] };
    const [value] = wire.rows[0]!;
    expect(value).toBe("9007199254740993.123456789012");
    for (const [token, expected] of [
      ["1234567890123456.5", "1234567890123456.5"],
      ["1.23456789012345678e20", "123456789012345680000"],
      ["0.10000000000000001", "0.1"],
      ["1e400", "Infinity"],
      ["1e-400", "0"],
    ]) {
      expect(String(JSON.parse(token))).toBe(expected);
    }
    const copyText = vi.fn(async () => true);
    const state = createState("oceanbase-oracle", undefined, undefined, false, { columns: wire.columns, values: [value], visible: [0], types: wire.column_types }, { copyText });

    await state.extractWithExtractor("php", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "native" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([[value]]);
    await state.copyWithExtractor("tsv");
    expect(copyText.mock.calls.at(-1)?.[1]?.rows).toEqual([[value]]);
  });

  it("keeps reordered visible types aligned when a legacy caller has no full types", async () => {
    const state = createState("oracle", undefined, undefined, false, {
      columns: ["D", "T"],
      values: ["2026-10-10 13:14:15", "2026-10-10 13:14:15.123456"],
      visible: [1, 0],
      types: ["DATE", "TIMESTAMP"],
      omitFullTypes: true,
    });
    expect(await state.extractWithExtractor("sql-inserts")).not.toBeNull();
    const request = mocks.extract.mock.calls.at(-1)![0];
    expect(request.columns.map((column: { sourceName: string; dataType: string }) => [column.sourceName, column.dataType])).toEqual([
      ["T", "TIMESTAMP"],
      ["D", "DATE"],
    ]);
  });

  it("uses display/edit/native value semantics while preserving internal pasteback rows", async () => {
    const internalNull = "__bson_null__";
    const internalPrefix = "__dbx_internal__:real-string";
    const values = [internalNull, "NULL", internalPrefix, "0x00"];
    const options = { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "display" as const };
    const copyText = vi.fn(async () => true);
    const state = createState(
      "mongodb",
      undefined,
      options,
      false,
      { columns: ["null", "text", "prefix", "binary"], values, visible: [0, 1, 2, 3], types: ["json", "text", "text", "varbinary"] },
      {
        copyText,
        externalCellValue: (value) => (value === internalNull ? null : value),
        displayValue: (value) => `D:${String(value)}`,
        editValue: (value) => `E:${String(value)}`,
      },
    );
    await state.extractWithExtractor("dbunit");
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([[null, "D:NULL", `D:${internalPrefix}`, "D:0x00"]]);
    await state.copyWithExtractor("tsv", { ...options, valueFormat: "edit" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([[null, "E:NULL", `E:${internalPrefix}`, "E:0x00"]]);
    expect(copyText.mock.calls.at(-1)?.[1]?.rows).toEqual([values]);
    await state.extractWithExtractor("dbunit", { ...options, valueFormat: "native" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([[null, "NULL", internalPrefix, "0x00"]]);
  });

  it("keeps BSON date and int64 semantics across display, edit, native, and raw pasteback", async () => {
    const values = [mongoDocumentGridValue({ $date: { $numberLong: "1789887723123" } }), mongoDocumentGridValue({ $numberLong: "9007199254740993" }), MONGO_DOCUMENT_GRID_NULL];
    const copyText = vi.fn(async () => true);
    const state = createState(
      "mongodb",
      undefined,
      undefined,
      false,
      { columns: ["when", "id", "nothing"], values, visible: [0, 1, 2], types: ["datetime", "int64", "json"] },
      {
        copyText,
        externalCellValue: mongoDocumentGridExternalValue,
        displayValue: (value) => mongoDocumentGridDisplayText(value) ?? String(value),
        editValue: (value) => mongoDocumentGridEditorText(value) ?? String(value),
      },
    );

    await state.extractWithExtractor("dbunit", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "display" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([['ISODate("2026-09-20T07:02:03.123Z")', 'NumberLong("9007199254740993")', null]]);
    await state.copyWithExtractor("tsv", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "edit" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([['{"$date":{"$numberLong":"1789887723123"}}', 'NumberLong("9007199254740993")', null]]);
    expect(mocks.extract.mock.calls.at(-1)![0].rows.flat().join(" ")).not.toContain("dbx:mongo-document-grid");
    expect(copyText.mock.calls[0]![1]?.rows).toEqual([values]);
    await state.extractWithExtractor("dbunit", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "native" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([['{"$date":{"$numberLong":"1789887723123"}}', 'NumberLong("9007199254740993")', null]]);
    expect(mocks.extract.mock.calls.at(-1)![0].rows.flat().join(" ")).not.toContain("dbx:mongo-document-grid");
  });

  it("formats Postgres arrays, temporal values, and large JSON only for clipboard value modes", async () => {
    const values = ["{a,b}", "2026-10-20 01:02:03.123456+00", '{"id":9007199254740993}'];
    const copyText = vi.fn(async () => true);
    const state = createState(
      "postgres",
      undefined,
      undefined,
      false,
      { columns: ["items", "created_at", "payload"], values, visible: [0, 1, 2], types: ["text[]", "timestamptz", "json"] },
      {
        copyText,
        displayValue: (value, index) => [`ARRAY[${String(value)}]`, `LOCAL:${String(value)}`, `JSON:${String(value)}`][index]!,
        editValue: (value, index) => [`EDIT ARRAY:${String(value)}`, `EDIT TIME:${String(value)}`, `EDIT JSON:${String(value)}`][index]!,
      },
    );
    await state.extractWithExtractor("csv", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "display" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([["ARRAY[{a,b}]", "LOCAL:2026-10-20 01:02:03.123456+00", `JSON:${values[2]}`]]);
    await state.extractWithExtractor("csv", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "edit" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([["EDIT ARRAY:{a,b}", "EDIT TIME:2026-10-20 01:02:03.123456+00", `EDIT JSON:${values[2]}`]]);
    await state.extractWithExtractor("csv", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "native" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([values]);
    await state.extractWithExtractor("sql-inserts");
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([values]);
    await state.copyWithExtractor("tsv", { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "edit" });
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([["EDIT ARRAY:{a,b}", "EDIT TIME:2026-10-20 01:02:03.123456+00", `EDIT JSON:${values[2]}`]]);
    expect(copyText.mock.calls[0]![1]?.rows).toEqual([values]);
  });

  it("formats cells with active column formatters for non-SQL extractors and keeps raw values for SQL extractors", async () => {
    const state = useDataGridExtractor({
      columns: computed(() => ["id", "amount"]),
      allColumns: computed(() => ["id", "amount"]),
      displayItems: computed(() => [{ id: 1, data: [1, 100], isDraft: false }]),
      allDisplayItems: computed(() => [{ id: 1, data: [1, 100], isDraft: false }]),
      allSourceColumns: computed(() => undefined),
      visibleColumnIndexes: computed(() => [0, 1]),
      columnTypes: computed(() => ["int", "decimal"]),
      allColumnTypes: computed(() => ["int", "decimal"]),
      extractorOptions: computed(() => DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS),
      databaseType: computed(() => "postgres"),
      identifierQuote: computed(() => undefined),
      tableMeta: computed(() => qualifiedMeta()),
      includeDatabaseName: computed(() => false),
      hasCellSelection: computed(() => false),
      selectedCells: computed(() => ({ columns: [], rows: [] })),
      selectedCellMatrix: computed(() => null),
      hasRowSelection: computed(() => true),
      hasColumnSelection: computed(() => false),
      selectedRowIds: ref(new Set<number>([1])),
      contextCell: ref(null),
      contextSelectionIsSynthetic: ref(false),
      copyText: vi.fn(async () => true),
      canCopySqlInsert: () => true,
      buildMongoInsert: vi.fn(async () => undefined),
      hasColumnFormatter: (idx) => idx === 1,
      displayValue: (val, idx) => (idx === 1 ? `$${val}` : String(val)),
      applyColumnFormattersOnExport: computed(() => true),
    });

    await state.extractWithExtractor("csv");
    const csvRequest = mocks.extract.mock.calls.at(-1)![0];
    expect(csvRequest.rows).toEqual([[1, "$100"]]);

    await state.extractWithExtractor("sql-inserts");
    const sqlRequest = mocks.extract.mock.calls.at(-1)![0];
    expect(sqlRequest.rows).toEqual([[1, 100]]);
  });

  it("does not classify INTERVAL as a numeric column when applying CSV number display", async () => {
    const options = { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, dsv: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv, formatNumbers: "display" as const } };
    const state = createState("postgres", undefined, options, false, { columns: ["duration", "amount"], values: ["-1 day", 10], visible: [0, 1], types: ["INTERVAL", "DECIMAL"] }, { displayValue: (value) => `D:${String(value)}` });
    await state.extractWithExtractor("csv");
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([["-1 day", "D:10"]]);
  });

  it.each(["DEC", "FIXED", "SMALLMONEY", "UInt8"])("applies numeric display formatting to %s", async (dataType) => {
    const options = { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, dsv: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv, formatNumbers: "display" as const } };
    const state = createState("postgres", undefined, options, false, { columns: ["amount"], values: [12], visible: [0], types: [dataType] }, { displayValue: (value) => `D:${String(value)}` });
    await state.extractWithExtractor("csv");
    expect(mocks.extract.mock.calls.at(-1)![0].rows).toEqual([["D:12"]]);
  });
});
