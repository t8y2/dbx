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

function createState(databaseType: DatabaseType, tableMeta: DataGridTableMeta, extractorOptions?: DataGridExtractorOptions, includeDatabaseName = false) {
  const items = [{ id: 1, data: [1, "Ada"], isDraft: false }];
  return useDataGridExtractor({
    columns: computed(() => ["id", "name"]),
    allColumns: computed(() => ["id", "name"]),
    displayItems: computed(() => items),
    allDisplayItems: computed(() => items),
    allSourceColumns: computed(() => undefined),
    visibleColumnIndexes: computed(() => [0, 1]),
    columnTypes: computed(() => undefined),
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
});
