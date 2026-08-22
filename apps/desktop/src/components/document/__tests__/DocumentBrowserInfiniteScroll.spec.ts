// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDataGridPrefixAppend } from "@/lib/dataGrid/dataGridInfiniteScroll";

const backend = vi.hoisted(() => ({
  documentFindDocuments: vi.fn(),
  documentCountDocuments: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  documentInsertDocument: vi.fn(),
  documentUpdateDocument: vi.fn(),
  documentDeleteDocument: vi.fn(),
  documentSaveMeilisearchBatch: vi.fn(),
}));

const dataGrid = vi.hoisted(() => ({
  paginate: undefined as ((offset: number, limit: number) => Promise<void>) | undefined,
  reload: undefined as (() => Promise<void>) | undefined,
  save: undefined as ((changes: { dirtyRows: Map<number, Map<number, unknown>>; deletedRows: Set<number>; newRows: unknown[][]; newRowMeta: unknown[]; columns: string[]; rows: unknown[][] }) => Promise<void>) | undefined,
  resetInfiniteScrollState: undefined as ReturnType<typeof vi.fn> | undefined,
  previousResult: undefined as { rows: readonly unknown[]; appended_from_row_count?: number } | undefined,
  rows: [] as unknown[],
  columns: [] as string[],
  appendedFromRowCount: undefined as number | undefined,
  pageOffset: undefined as number | undefined,
  pageLimit: undefined as number | undefined,
  pageSizePreference: undefined as string | undefined,
  selectionActive: false,
  editActive: false,
  fullReplaceCount: 0,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 2,
    tableOpenPageSize: 5,
    infiniteScroll: true,
    mongoViewMode: "table" as "document" | "table",
    columnWidthDensity: "standard" as "compact" | "standard" | "comfortable",
    dataGridRenderMode: "canvas" as "canvas" | "dom",
    tableFontFamily: "system-ui",
    tableFontSize: 12,
    numericColumnRightAlign: true,
    confirmDangerousSqlExecution: true,
    exportBatchSize: 2,
    exportRowLimitEnabled: false,
    exportRowLimit: 100_000,
  },
  updateEditorSettings: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: vi.fn(),
  documentFindDocuments: backend.documentFindDocuments,
  documentCountDocuments: backend.documentCountDocuments,
  dynamodbDescribeTable: vi.fn(),
  cancelQuery: backend.cancelQuery,
  documentInsertDocument: backend.documentInsertDocument,
  documentUpdateDocument: backend.documentUpdateDocument,
  documentDeleteDocument: backend.documentDeleteDocument,
  documentSaveMeilisearchBatch: backend.documentSaveMeilisearchBatch,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: backend.ensureConnected }),
}));

vi.mock("@/stores/settingsStore", () => ({
  TABLE_FONT_SIZE_MIN: 8,
  TABLE_FONT_SIZE_MAX: 16,
  useSettingsStore: () => settings,
}));

vi.mock("@/components/grid/DataGrid.vue", () => {
  return {
    default: defineComponent({
      name: "DataGridStub",
      inheritAttrs: false,
      props: {
        result: { type: Object, required: true },
        customSaveHandler: { type: Object, required: false },
        pageOffset: { type: Number, required: false },
        pageLimit: { type: Number, required: false },
        pageSizePreference: { type: String, required: false },
      },
      setup(props, { attrs, expose }) {
        dataGrid.paginate = attrs.onPaginate as typeof dataGrid.paginate;
        dataGrid.reload = attrs.onReload as typeof dataGrid.reload;
        dataGrid.save = (props.customSaveHandler as { save?: typeof dataGrid.save } | undefined)?.save;
        const resetInfiniteScrollState = vi.fn();
        dataGrid.resetInfiniteScrollState = resetInfiniteScrollState;
        expose({
          visibleColumnCount: 2,
          displayableColumnCount: 2,
          hiddenColumnCount: 0,
          orderedColumnLayoutOptions: [],
          filteredColumnLayoutOptions: () => [],
          toggleColumnVisibility: vi.fn(),
          showAllColumns: vi.fn(),
          invertColumnVisibility: vi.fn(),
          hasCustomColumnOrder: false,
          moveDisplayableColumn: vi.fn(),
          resetColumnOrder: vi.fn(),
          nullColumnsHidden: false,
          canToggleAllNullColumns: false,
          allNullColumnCount: 0,
          toggleAllNullColumns: vi.fn(),
          multiRowTranspose: false,
          setMultiRowTranspose: vi.fn(),
          resetInfiniteScrollState,
        });
        return () => {
          const result = props.result as { rows: unknown[]; columns?: string[]; appended_from_row_count?: number };
          if (dataGrid.previousResult && dataGrid.previousResult !== result && !isDataGridPrefixAppend(dataGrid.previousResult, result)) {
            dataGrid.selectionActive = false;
            dataGrid.editActive = false;
            dataGrid.fullReplaceCount += 1;
          }
          dataGrid.previousResult = result;
          dataGrid.rows = result.rows;
          dataGrid.columns = result.columns ?? [];
          dataGrid.appendedFromRowCount = result.appended_from_row_count;
          dataGrid.pageOffset = props.pageOffset;
          dataGrid.pageLimit = props.pageLimit;
          dataGrid.pageSizePreference = props.pageSizePreference;
          return h("div", { "data-testid": "data-grid" });
        };
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, required: true } },
      setup(props) {
        return () => h("div", {}, props.modelValue);
      },
    }),
  };
});

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Popover: passthrough("PopoverStub"), PopoverTrigger: passthrough("PopoverTriggerStub"), PopoverContent: passthrough("PopoverContentStub") };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Select: passthrough("SelectStub"), SelectContent: passthrough("SelectContentStub"), SelectItem: passthrough("SelectItemStub"), SelectTrigger: passthrough("SelectTriggerStub"), SelectValue: passthrough("SelectValueStub") };
});

import DocumentBrowser from "@/components/document/DocumentBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountBrowser(databaseType: "mongodb" | "elasticsearch" = "mongodb") {
  app = createApp(DocumentBrowser, {
    connectionId: "mongo-1",
    database: "test",
    collection: "docs",
    databaseType,
  });
  app.mount(root!);
  await flushUi();
}

function documentResult(start: number, count: number, total: number, extra: Record<string, unknown> = {}) {
  return {
    documents: Array.from({ length: count }, (_, index) => {
      const id = start + index;
      return { _id: String(id), name: `row_${id}`, ...extra };
    }),
    total,
    total_is_exact: true,
  };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  backend.documentFindDocuments.mockReset();
  backend.documentCountDocuments.mockReset();
  backend.cancelQuery.mockReset();
  backend.ensureConnected.mockReset();
  backend.documentInsertDocument.mockReset();
  backend.documentUpdateDocument.mockReset();
  backend.documentDeleteDocument.mockReset();
  backend.documentSaveMeilisearchBatch.mockReset();
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(0);
  dataGrid.paginate = undefined;
  dataGrid.reload = undefined;
  dataGrid.save = undefined;
  dataGrid.resetInfiniteScrollState = undefined;
  dataGrid.previousResult = undefined;
  dataGrid.rows = [];
  dataGrid.columns = [];
  dataGrid.appendedFromRowCount = undefined;
  dataGrid.pageOffset = undefined;
  dataGrid.pageLimit = undefined;
  dataGrid.pageSizePreference = undefined;
  dataGrid.selectionActive = false;
  dataGrid.editActive = false;
  dataGrid.fullReplaceCount = 0;
  settings.editorSettings.pageSize = 2;
  settings.editorSettings.tableOpenPageSize = 5;
  settings.editorSettings.infiniteScroll = true;

  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("DocumentBrowser infinite scroll (issue #6455)", () => {
  it.each(["mongodb", "elasticsearch"] as const)("uses the table-open page-size preference for %s", async (databaseType) => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 5, 5));

    await mountBrowser(databaseType);

    expect(backend.documentFindDocuments.mock.calls[0]!.slice(0, 5)).toEqual(["mongo-1", "test", "docs", 0, 5]);
    expect(dataGrid.pageLimit).toBe(5);
    expect(dataGrid.pageSizePreference).toBe("table-open");
  });

  it("preserves existing row identity and DataGrid selection/edit state for same-column appends", async () => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 2, 4)).mockResolvedValueOnce(documentResult(3, 2, 4));

    await mountBrowser();

    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
    const firstRows = [...dataGrid.rows];
    dataGrid.selectionActive = true;
    dataGrid.editActive = true;

    expect(dataGrid.paginate).toBeTypeOf("function");
    await dataGrid.paginate!(2, 2);
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls[1]!.slice(0, 5)).toEqual(["mongo-1", "test", "docs", 2, 2]);
    // The second page must be grafted onto the first, not replace it —
    // otherwise scrolling past the first batch silently discards it (#6455).
    expect(dataGrid.rows).toHaveLength(4);
    expect(dataGrid.rows.map((row) => (row as unknown[])[1])).toEqual(["row_1", "row_2", "row_3", "row_4"]);
    expect(dataGrid.appendedFromRowCount).toBe(2);
    expect(dataGrid.rows[0]).toBe(firstRows[0]);
    expect(dataGrid.rows[1]).toBe(firstRows[1]);
    expect(dataGrid.selectionActive).toBe(true);
    expect(dataGrid.editActive).toBe(true);
  });

  it("performs a full row rebuild when an appended segment introduces a new column", async () => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 2, 4)).mockResolvedValueOnce(documentResult(3, 2, 4, { status: "new" }));

    await mountBrowser();
    const firstRow = dataGrid.rows[0];
    dataGrid.selectionActive = true;
    dataGrid.editActive = true;

    await dataGrid.paginate!(2, 2);
    await flushUi();

    expect(dataGrid.columns).toEqual(["_id", "name", "status"]);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
    expect(dataGrid.rows[0]).not.toBe(firstRow);
    expect(dataGrid.selectionActive).toBe(false);
    expect(dataGrid.editActive).toBe(false);
  });

  it("reloads from offset zero after three segments are refreshed", async () => {
    backend.documentFindDocuments
      .mockResolvedValueOnce(documentResult(1, 2, 8))
      .mockResolvedValueOnce(documentResult(3, 2, 8))
      .mockResolvedValueOnce(documentResult(5, 2, 8))
      .mockResolvedValueOnce(documentResult(1, 2, 8, { refreshed: true }));

    await mountBrowser();
    await dataGrid.paginate!(2, 2);
    await dataGrid.paginate!(4, 2);
    await flushUi();
    expect(dataGrid.rows).toHaveLength(6);

    await dataGrid.reload!();
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls[3]!.slice(0, 5)).toEqual(["mongo-1", "test", "docs", 0, 5]);
    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
    expect(dataGrid.pageOffset).toBe(0);
    expect(dataGrid.pageLimit).toBe(5);
    expect(dataGrid.resetInfiniteScrollState).toHaveBeenCalledTimes(1);
  });

  it("reloads from offset zero after saving with three segments loaded", async () => {
    backend.documentFindDocuments
      .mockResolvedValueOnce(documentResult(1, 2, 8))
      .mockResolvedValueOnce(documentResult(3, 2, 8))
      .mockResolvedValueOnce(documentResult(5, 2, 8))
      .mockResolvedValueOnce(documentResult(1, 2, 8, { saved: true }));

    await mountBrowser();
    await dataGrid.paginate!(2, 2);
    await dataGrid.paginate!(4, 2);
    await flushUi();

    await dataGrid.save!({
      dirtyRows: new Map([[0, new Map([[1, "row_1_updated"]])]]),
      deletedRows: new Set(),
      newRows: [],
      newRowMeta: [],
      columns: [...dataGrid.columns],
      rows: dataGrid.rows as unknown[][],
    });
    await flushUi();

    expect(backend.documentUpdateDocument).toHaveBeenCalledTimes(1);
    expect(backend.documentFindDocuments.mock.calls[3]!.slice(0, 5)).toEqual(["mongo-1", "test", "docs", 0, 5]);
    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
    expect(dataGrid.pageOffset).toBe(0);
    expect(dataGrid.pageLimit).toBe(5);
    expect(dataGrid.resetInfiniteScrollState).toHaveBeenCalledTimes(1);
  });

  it("keeps the configured page size when the final capped segment has a smaller limit", async () => {
    settings.editorSettings.tableOpenPageSize = 3;
    backend.documentFindDocuments
      .mockResolvedValueOnce(documentResult(1, 3, 11))
      .mockResolvedValueOnce(documentResult(4, 3, 11))
      .mockResolvedValueOnce(documentResult(7, 3, 11))
      .mockResolvedValueOnce(documentResult(10, 2, 11));

    await mountBrowser();
    const firstRow = dataGrid.rows[0];
    await dataGrid.paginate!(3, 3);
    await dataGrid.paginate!(6, 3);
    await dataGrid.paginate!(9, 2);
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls.map((call) => call.slice(3, 5))).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
      [9, 2],
    ]);
    expect(dataGrid.rows).toHaveLength(11);
    expect(dataGrid.rows[0]).toBe(firstRow);
    expect(dataGrid.appendedFromRowCount).toBe(9);
    expect(dataGrid.pageLimit).toBe(3);
    expect(dataGrid.pageOffset).toBe(9);
  });

  it("replaces the documents instead of appending when infinite scroll is disabled", async () => {
    settings.editorSettings.infiniteScroll = false;
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 2, 4)).mockResolvedValueOnce(documentResult(3, 2, 4));

    await mountBrowser();

    await dataGrid.paginate!(2, 2);
    await flushUi();

    // Classic next-page navigation must keep replacing the page, not accumulate rows.
    expect(dataGrid.rows).toHaveLength(2);
    expect(dataGrid.rows.map((row) => (row as unknown[])[1])).toEqual(["row_3", "row_4"]);
    expect(dataGrid.appendedFromRowCount).toBeUndefined();
  });
});
