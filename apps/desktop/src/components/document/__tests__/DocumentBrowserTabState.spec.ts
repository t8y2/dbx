// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  sort: undefined as ((column: string, columnIndex: number, direction: "asc" | "desc" | null) => void) | undefined,
  pageOffset: undefined as number | undefined,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 2,
    tableOpenPageSize: 2,
    infiniteScroll: false,
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
        pageOffset: { type: Number, required: false },
        pageLimit: { type: Number, required: false },
        pageSizePreference: { type: String, required: false },
      },
      setup(props, { attrs, expose, slots }) {
        dataGrid.paginate = attrs.onPaginate as typeof dataGrid.paginate;
        dataGrid.sort = attrs.onSort as typeof dataGrid.sort;
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
          resetInfiniteScrollState: vi.fn(),
        });
        return () => {
          dataGrid.pageOffset = props.pageOffset;
          return h("div", [
            // Rendering the real search-bar slot exposes the filter/sort inputs
            // the same way the actual grid toolbar does.
            h("div", slots["search-bar"]?.({ localFilterCount: 0, hasLocalColumnFilters: false, localFilterSummaries: [], clearLocalFilter: () => undefined })),
            h("div", { "data-testid": "data-grid" }, (props.result as { rows: unknown[] }).rows.length),
          ]);
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

async function mountBrowser(options: { databaseType?: "mongodb" | "elasticsearch"; stateKey?: string } = {}) {
  app = createApp(DocumentBrowser, {
    connectionId: "conn-1",
    database: "test",
    collection: "docs",
    databaseType: options.databaseType ?? "mongodb",
    stateKey: options.stateKey,
  });
  app.mount(root!);
  await flushUi();
}

function documentResult(start: number, count: number, total: number, extra: Record<string, unknown> = {}) {
  return {
    documents: Array.from({ length: count }, (_, index) => {
      const id = start + index;
      return { _id: String(id), name: `row_${id}` };
    }),
    total,
    total_is_exact: true,
    ...extra,
  };
}

function queryTextareas(): HTMLTextAreaElement[] {
  return [...root!.querySelectorAll("textarea.document-query-input")];
}

function typeInTextarea(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(textarea: HTMLTextAreaElement) {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(0);
  backend.documentFindDocuments.mockResolvedValue(documentResult(1, 2, 2));
  dataGrid.paginate = undefined;
  dataGrid.sort = undefined;
  dataGrid.pageOffset = undefined;
  settings.editorSettings.infiniteScroll = false;

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

describe("DocumentBrowser tab state (tab switch persistence)", () => {
  it("restores filter and sort conditions after unmount/remount", async () => {
    await mountBrowser({ stateKey: "tab-filter-sort" });
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(1);

    const [filterTextarea] = queryTextareas();
    typeInTextarea(filterTextarea, '{"name":"row_1"}');
    await flushUi();
    pressEnter(filterTextarea);
    await flushUi();
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(2);
    expect(backend.documentFindDocuments.mock.calls[1]![5]).toBe(JSON.stringify({ name: "row_1" }));

    dataGrid.sort!("name", 1, "asc");
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls[2]![7]).toBe(JSON.stringify({ name: 1 }));

    // Switch away (unmount) and back (remount) — what ContentArea does per tab.
    app!.unmount();
    app = null;
    root!.replaceChildren();
    await flushUi();
    await mountBrowser({ stateKey: "tab-filter-sort" });

    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(4);
    const restoredCall = backend.documentFindDocuments.mock.calls[3]!;
    expect(restoredCall[5]).toBe(JSON.stringify({ name: "row_1" }));
    expect(restoredCall[7]).toBe(JSON.stringify({ name: 1 }));

    const [restoredFilter, restoredSort] = queryTextareas();
    expect(restoredFilter.value).toBe('{"name":"row_1"}');
    expect(restoredSort.value).toBe(JSON.stringify({ name: 1 }));
  });

  it("restores the page position for skip-based stores", async () => {
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValue(documentResult(1, 2, 6));

    await mountBrowser({ stateKey: "tab-page" });
    expect(backend.documentFindDocuments.mock.calls[0]![3]).toBe(0);

    await dataGrid.paginate!(2, 2);
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls[1]![3]).toBe(2);

    app!.unmount();
    app = null;
    root!.replaceChildren();
    await flushUi();
    await mountBrowser({ stateKey: "tab-page" });

    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(3);
    expect(backend.documentFindDocuments.mock.calls[2]![3]).toBe(2);
    expect(dataGrid.pageOffset).toBe(2);
  });

  it("restarts from the first page for cursor-based stores (elasticsearch)", async () => {
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 2, 6, { next_cursor: "cursor-1" })).mockResolvedValue(documentResult(3, 2, 6));

    await mountBrowser({ databaseType: "elasticsearch", stateKey: "tab-es" });

    await dataGrid.paginate!(2, 2);
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls[1]![3]).toBe(0);
    expect(backend.documentFindDocuments.mock.calls[1]![10]).toBe("cursor-1");

    app!.unmount();
    app = null;
    root!.replaceChildren();
    await flushUi();
    await mountBrowser({ databaseType: "elasticsearch", stateKey: "tab-es" });

    const restoredCall = backend.documentFindDocuments.mock.calls.at(-1)!;
    expect(restoredCall[3]).toBe(0);
    expect(restoredCall[10]).toBeUndefined();
  });

  it("keeps tab states isolated from each other", async () => {
    await mountBrowser({ stateKey: "tab-a" });
    dataGrid.sort!("name", 1, "asc");
    await flushUi();
    app!.unmount();
    app = null;
    root!.replaceChildren();

    await mountBrowser({ stateKey: "tab-b" });
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(3);
    expect(backend.documentFindDocuments.mock.calls[2]![7]).toBeUndefined();
  });
});
