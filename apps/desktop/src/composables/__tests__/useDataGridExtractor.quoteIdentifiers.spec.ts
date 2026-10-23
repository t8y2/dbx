import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import { useSettingsStore } from "@/stores/settingsStore";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ extractDataGridSelection: mocks.extract }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const tableMeta: DataGridTableMeta = {
  tableName: "USERS",
  schema: "APP",
  primaryKeys: ["ID"],
  columns: [
    { name: "ID", data_type: "NUMBER" },
    { name: "NAME", data_type: "VARCHAR2" },
  ],
};

function createState(extractorOptions: DataGridExtractorOptions) {
  const items = [{ id: 1, data: [7, "Ada"], isDraft: false }];
  return useDataGridExtractor({
    columns: computed(() => ["ID", "NAME"]),
    allColumns: computed(() => ["ID", "NAME"]),
    displayItems: computed(() => items),
    allDisplayItems: computed(() => items),
    allSourceColumns: computed(() => undefined),
    visibleColumnIndexes: computed(() => [0, 1]),
    columnTypes: computed(() => ["NUMBER", "VARCHAR2"]),
    allColumnTypes: computed(() => ["NUMBER", "VARCHAR2"]),
    extractorOptions: computed(() => extractorOptions),
    databaseType: computed(() => "oracle"),
    identifierQuote: computed(() => '"'),
    tableMeta: computed(() => tableMeta),
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

async function lastRequest(extractorOptions: DataGridExtractorOptions, extractor: "sql-inserts" | "sql-updates" = "sql-inserts") {
  const state = createState(extractorOptions);
  const extraction = await state.extractWithExtractor(extractor);
  expect(extraction).not.toBeNull();
  return mocks.extract.mock.calls.at(-1)![0];
}

describe("useDataGridExtractor quoteIdentifiers master-switch merge (#12878)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extract.mockResolvedValue({ text: "SQL", rowCount: 1 });
    setActivePinia(createPinia());
  });

  it("keeps the extractor checkbox honored while the editor switch is on", async () => {
    const request = await lastRequest({
      ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
      sql: { ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.sql, quoteIdentifiers: false },
    });
    expect(request.options.sql.quoteIdentifiers).toBe(false);
  });

  it("forces quotes off in the copy request when the editor switch is off", async () => {
    useSettingsStore().updateEditorSettings({ generateSqlQuoteIdentifiers: false });
    // The extractor checkbox itself stays checked in the saved copy options;
    // the master switch is the upper bound and must override it.
    const request = await lastRequest(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS);
    expect(request.options.sql.quoteIdentifiers).toBe(false);
  });

  it("applies the override to UPDATE extraction requests too", async () => {
    useSettingsStore().updateEditorSettings({ generateSqlQuoteIdentifiers: false });
    const request = await lastRequest(DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, "sql-updates");
    expect(request.options.sql.quoteIdentifiers).toBe(false);
  });

  it("leaves value-oriented extractor options untouched", async () => {
    useSettingsStore().updateEditorSettings({ generateSqlQuoteIdentifiers: false });
    const request = await lastRequest({ ...DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, valueFormat: "edit" });
    expect(request.options.valueFormat).toBe("edit");
  });
});
