import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import type { DatabaseType } from "@/types/database";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ extractDataGridSelection: mocks.extract }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function createState(databaseType: DatabaseType, tableMeta: DataGridTableMeta | undefined, extractorOptions?: DataGridExtractorOptions, includeDatabaseName = false, query?: { columns: string[]; values: unknown[]; visible: number[]; types: string[]; omitFullTypes?: boolean }) {
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

  it.each([
    ["sqlserver", "dbo", "app"],
    ["snowflake", "PUBLIC", undefined],
  ] as const)("keeps the namespace flag true for %s even when the option is off", async (databaseType, schema, database) => {
    const request = await capturedRequest(databaseType, qualifiedMeta(schema, database));
    expect(request.tableMeta.schema).toBe(schema);
    expect(request.options.sql.includeDatabaseName).toBe(true);
  });

  it("strips optional qualifiers and keeps the flag off for non schema-qualified dialects", async () => {
    const request = await capturedRequest("mysql", qualifiedMeta(undefined, "mydb"));
    expect(request.tableMeta.database).toBeUndefined();
    expect(request.tableMeta.schema).toBeUndefined();
    expect(request.options.sql.includeDatabaseName).toBe(false);
  });

  it("preserves an explicit opt-in for non schema-qualified dialects", async () => {
    const request = await capturedRequest("mysql", qualifiedMeta(undefined, "mydb"), { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, includeDatabaseName: true } });
    expect(request.tableMeta.database).toBe("mydb");
    expect(request.options.sql.includeDatabaseName).toBe(true);
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
});
