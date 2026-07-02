import { strict as assert } from "node:assert";
import { beforeEach, test, vi } from "vitest";
import { computed, ref } from "vue";
import { useDataGridExport } from "../../apps/desktop/src/composables/useDataGridExport.ts";
import { copyToClipboard } from "@/lib/clipboard";
import * as api from "@/lib/api";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => {}),
}));

vi.mock("@/lib/api", () => ({
  exportQueryResultCsv: vi.fn(async () => {}),
}));

const draftRowId = Number.MIN_SAFE_INTEGER;

function createExportContext(options: {
  contextRowId?: number;
  selectedRowIds?: Set<number>;
  fullExportResult?: () => Promise<{ columns: string[]; rows: Array<Array<string | number | boolean | null>>; affected_rows: number; execution_time_ms: number }>;
} = {}) {
  const contextRowId = options.contextRowId ?? draftRowId;
  const selectedRowIds = ref(options.selectedRowIds ?? new Set<number>());
  const rows = [
    {
      id: 0,
      sourceIndex: 0,
      data: [1, "Ada"],
      isNew: false,
      isDeleted: false,
      isDirtyCol: [false, false],
      status: "clean",
    },
    {
      id: draftRowId,
      data: [null, null],
      isNew: false,
      isDraft: true,
      isDeleted: false,
      isDirtyCol: [false, false],
      status: "draft",
    },
  ];

  return useDataGridExport({
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => rows),
    sql: computed(() => undefined),
    tableMeta: computed(() => undefined),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    context: computed(() => "table-data"),
    sourceColumns: computed(() => undefined),
    columnTypes: computed(() => undefined),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedRange: computed(() => null),
    contextCell: ref({ rowId: contextRowId, rowIndex: contextRowId === draftRowId ? 1 : 0, col: 1 }),
    getRowItem: (rowId) => rows.find((row) => row.id === rowId),
    selectedRowIds,
    hasRowSelection: computed(() => selectedRowIds.value.size > 0),
    fullExportResult: options.fullExportResult,
  });
}

beforeEach(() => {
  globalThis.window = {
    setTimeout,
    clearTimeout,
  } as unknown as Window & typeof globalThis;
  vi.mocked(copyToClipboard).mockClear();
  vi.mocked(api.exportQueryResultCsv).mockClear();
});

test("direct draft cell copy is ignored", async () => {
  const exporter = createExportContext();

  await exporter.copyCell();

  assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
});

test("direct draft row copy is ignored", async () => {
  const exporter = createExportContext();

  await exporter.copyRow();

  assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
});

test("selected draft row TSV copy is ignored", async () => {
  const exporter = createExportContext({ selectedRowIds: new Set([draftRowId]) });

  await exporter.copySelectedRowsTsv();

  assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
});

test("empty selected row export does not fall back to full export", async () => {
  let fullExportCalls = 0;
  const exporter = createExportContext({
    fullExportResult: async () => {
      fullExportCalls += 1;
      return {
        columns: ["id", "name"],
        rows: [[1, "Ada"]],
        affected_rows: 1,
        execution_time_ms: 1,
      };
    },
  });

  await exporter.exportCsv([]);

  assert.equal(fullExportCalls, 0);
  assert.deepEqual(vi.mocked(api.exportQueryResultCsv).mock.calls[0]?.slice(1, 3), [["id", "name"], []]);
});
