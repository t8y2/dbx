import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ extractDataGridSelection: mocks.extract }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function tableMeta(): DataGridTableMeta {
  return {
    tableName: "users",
    schema: "public",
    primaryKeys: ["id"],
    columns: [
      { name: "id", data_type: "int" },
      { name: "name", data_type: "varchar" },
    ],
  };
}

function createState(extractorOptions: DataGridExtractorOptions, quoteIdentifiers: boolean) {
  const items = [{ id: 1, data: [1, "Ada"], isDraft: false }];
  return useDataGridExtractor({
    columns: computed(() => ["id", "name"]),
    allColumns: computed(() => ["id", "name"]),
    displayItems: computed(() => items),
    allDisplayItems: computed(() => items),
    allSourceColumns: computed(() => undefined),
    visibleColumnIndexes: computed(() => [0, 1]),
    columnTypes: computed(() => ["int", "varchar"]),
    allColumnTypes: computed(() => ["int", "varchar"]),
    extractorOptions: computed(() => extractorOptions),
    databaseType: computed(() => "postgres"),
    identifierQuote: computed(() => '"'),
    tableMeta: computed(() => tableMeta()),
    includeDatabaseName: computed(() => false),
    quoteIdentifiers: computed(() => quoteIdentifiers),
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

async function capturedRequest(extractorOptions: DataGridExtractorOptions, quoteIdentifiers: boolean) {
  const state = createState(extractorOptions, quoteIdentifiers);
  const extraction = await state.extractWithExtractor("sql-inserts");
  expect(extraction).not.toBeNull();
  return mocks.extract.mock.calls[mocks.extract.mock.calls.length - 1]![0]!;
}

function withExtractorQuoting(quoteIdentifiers: boolean): DataGridExtractorOptions {
  return { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, quoteIdentifiers } };
}

describe("useDataGridExtractor quoteIdentifiers payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extract.mockResolvedValue({ text: 'INSERT INTO "public"."users" VALUES (1, \'Ada\');', rowCount: 1 });
  });

  it("quotes identifiers when both the editor setting and the copy option are on", async () => {
    const request = await capturedRequest(withExtractorQuoting(true), true);
    expect(request.options.sql.quoteIdentifiers).toBe(true);
  });

  it("drops quoting when the editor setting is off even though the copy option stays on", async () => {
    const request = await capturedRequest(withExtractorQuoting(true), false);
    expect(request.options.sql.quoteIdentifiers).toBe(false);
  });

  it("keeps the per-format opt-out when the editor setting is on", async () => {
    const request = await capturedRequest(withExtractorQuoting(false), true);
    expect(request.options.sql.quoteIdentifiers).toBe(false);
  });
});
