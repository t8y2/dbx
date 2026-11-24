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
  mongoListIndexSpecs: vi.fn(),
}));

const dataGrid = vi.hoisted(() => ({
  paginate: undefined as ((offset: number, limit: number) => Promise<void>) | undefined,
  sort: undefined as ((column: string, columnIndex: number, direction: "asc" | "desc" | null) => void) | undefined,
  reload: undefined as (() => Promise<void>) | undefined,
  pageOffset: undefined as number | undefined,
  rowCount: undefined as number | undefined,
  columnCount: undefined as number | undefined,
  localColumnFilters: undefined as Record<string, string[]> | undefined,
  localColumnFilterColumns: undefined as string[] | undefined,
  localFiltersChange: undefined as ((filters: Record<string, string[]>) => void) | undefined,
  viewStateKey: undefined as string | undefined,
  viewGeneration: undefined as string | undefined,
  columns: [] as string[],
  rows: [] as unknown[][],
  readonlyColumns: undefined as string[] | undefined,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 2,
    tableOpenPageSize: 2,
    infiniteScroll: false,
    mongoViewMode: "table" as "document" | "table" | "tree",
    mongoFlattenNestedFields: false,
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
  mongoListIndexSpecs: backend.mongoListIndexSpecs,
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
        viewStateKey: { type: String, required: false },
        viewGeneration: { type: String, required: false },
        localColumnFilterColumns: { type: Array, required: false },
        customSaveHandler: { type: Object, required: false },
      },
      setup(props, { attrs, expose, slots }) {
        dataGrid.paginate = attrs.onPaginate as typeof dataGrid.paginate;
        dataGrid.sort = attrs.onSort as typeof dataGrid.sort;
        dataGrid.reload = attrs.onReload as typeof dataGrid.reload;
        dataGrid.localFiltersChange = attrs.onLocalColumnFiltersChange as typeof dataGrid.localFiltersChange;
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
          dataGrid.viewStateKey = props.viewStateKey;
          dataGrid.viewGeneration = props.viewGeneration;
          dataGrid.rowCount = (props.result as { rows: unknown[] }).rows.length;
          dataGrid.columnCount = (props.result as { columns: unknown[] }).columns.length;
          dataGrid.columns = [...(props.result as { columns: string[] }).columns];
          dataGrid.rows = (props.result as { rows: unknown[][] }).rows;
          dataGrid.readonlyColumns = (props.customSaveHandler as { readonlyColumns?: string[] } | undefined)?.readonlyColumns;
          dataGrid.localColumnFilters = (props.result as { local_column_filters?: Record<string, string[]> }).local_column_filters;
          dataGrid.localColumnFilterColumns = props.localColumnFilterColumns as string[] | undefined;
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
import { resetBrowserStateCaches } from "@/lib/tabs/documentBrowserStateCache";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountBrowser() {
  app = createApp(DocumentBrowser, { connectionId: "conn-1", database: "test", collection: "people", databaseType: "mongodb", stateKey: "tab-nested" });
  app.mount(root!);
  await flushUi();
}

const nestedDocuments = [
  { _id: { $oid: "65f0c0ffee0000000000aaaa" }, name: "Ann", address: { city: "Bangkok", zip: "10110" }, tags: ["a", "b"] },
  { _id: { $oid: "65f0c0ffee0000000000bbbb" }, name: "Bo", address: { city: "Chiang Mai" } },
];

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(2);
  backend.documentFindDocuments.mockReset();
  backend.documentFindDocuments.mockResolvedValue({ documents: nestedDocuments, total: 2, total_is_exact: true });
  backend.mongoListIndexSpecs.mockReset();
  backend.mongoListIndexSpecs.mockResolvedValue([{ name: "name_1", keys: [{ field: "name", direction: "1" }], is_unique: true }]);
  backend.documentUpdateDocument.mockReset();
  backend.documentUpdateDocument.mockResolvedValue(1);
  settings.editorSettings.mongoViewMode = "table";
  settings.editorSettings.mongoFlattenNestedFields = false;
  settings.updateEditorSettings.mockReset();
  dataGrid.columns = [];
  dataGrid.rows = [];
  dataGrid.readonlyColumns = undefined;
  resetBrowserStateCaches();
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

describe("DocumentBrowser nested MongoDB views", () => {
  it("keeps top-level columns by default", async () => {
    await mountBrowser();
    expect(dataGrid.columns).toEqual(["_id", "name", "address", "tags"]);
    expect(dataGrid.readonlyColumns).toBeUndefined();
  });

  it("expands a subdocument column into read-only dot-path columns", async () => {
    await mountBrowser();
    const checkbox = [...root!.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((input) => input.closest("label")?.textContent?.trim() === "address");
    expect(checkbox).toBeDefined();
    checkbox!.dispatchEvent(new Event("change"));
    await flushUi();
    expect(dataGrid.columns).toEqual(["_id", "name", "address.city", "address.zip", "tags"]);
    expect(dataGrid.readonlyColumns).toEqual(["address.city", "address.zip"]);
    expect(dataGrid.rows[1]?.[2]).toBe("Chiang Mai");
    // Missing nested fields stay blank, not NULL.
    expect(dataGrid.rows[1]?.[3]).toBe("");
  });

  it("flattens every subdocument when the preference is on", async () => {
    settings.editorSettings.mongoFlattenNestedFields = true;
    await mountBrowser();
    expect(dataGrid.columns).toEqual(["_id", "name", "address.city", "address.zip", "tags"]);
  });

  it("renders the tree view with expandable documents", async () => {
    settings.editorSettings.mongoViewMode = "tree";
    await mountBrowser();
    const tree = root!.querySelector("[data-mongo-tree-view]");
    expect(tree).not.toBeNull();
    const rootRows = [...tree!.querySelectorAll("[data-tree-row]")];
    expect(rootRows).toHaveLength(2);
    expect(rootRows[0]?.textContent).toContain("(01) 65f0c0ffee0000000000aaaa");
    expect(rootRows[0]?.textContent).toContain("Document");
    rootRows[0]!.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    await flushUi();
    const texts = [...tree!.querySelectorAll("[data-tree-row]")].map((row) => row.textContent ?? "");
    expect(texts.some((text) => text.includes("address") && text.includes("Object"))).toBe(true);
    expect(texts.some((text) => text.includes("tags") && text.includes("Array"))).toBe(true);
    // The tree query bar re-runs the collection query with the typed filter.
    const filter = root!.querySelector<HTMLInputElement>("[data-mongo-tree-query] input[placeholder='{}']");
    filter!.value = '{"name":"Ann"}';
    filter!.dispatchEvent(new Event("input"));
    filter!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flushUi();
    const lastCall = backend.documentFindDocuments.mock.calls.at(-1);
    expect(JSON.stringify(lastCall)).toContain("Ann");
  });

  async function mountTree() {
    settings.editorSettings.mongoViewMode = "tree";
    await mountBrowser();
    const tree = root!.querySelector("[data-mongo-tree-view]")!;
    tree.querySelector<HTMLButtonElement>("[data-tree-row] button[aria-expanded]")!.click();
    await flushUi();
    return tree;
  }

  function rowByKey(tree: Element, key: string): HTMLElement {
    const row = [...tree.querySelectorAll<HTMLElement>("[data-tree-row]")].find((candidate) => candidate.querySelector("span[title]")?.textContent?.trim() === key);
    if (!row) throw new Error(`row ${key} not found`);
    return row;
  }

  async function menuAction(row: HTMLElement, action: string) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    await flushUi();
    const item = document.querySelector<HTMLButtonElement>(`[data-tree-menu] [data-action="${action}"]`);
    expect(item, action).not.toBeNull();
    item!.click();
    await flushUi();
  }

  it("labels indexed fields in the tree", async () => {
    const tree = await mountTree();
    expect(backend.mongoListIndexSpecs).toHaveBeenCalledWith("conn-1", "test", "people");
    expect(rowByKey(tree, "name").querySelector("[data-tree-index-label]")?.textContent).toBe("(unique asc index)");
  });

  it("filters the collection by a value from the context menu", async () => {
    const tree = await mountTree();
    backend.documentFindDocuments.mockClear();
    await menuAction(rowByKey(tree, "name"), "filter");
    expect(JSON.stringify(backend.documentFindDocuments.mock.calls.at(-1))).toContain('{\\"name\\":\\"Ann\\"}');
  });

  it("shows a nested field as a Table view column", async () => {
    const tree = await mountTree();
    rowByKey(tree, "address").querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    await flushUi();
    await menuAction(rowByKey(tree, "city"), "show-column");
    expect(settings.updateEditorSettings).toHaveBeenCalledWith({ mongoViewMode: "table" });
  });

  it("edits a value inline with $set and keeps the field type", async () => {
    const tree = await mountTree();
    await menuAction(rowByKey(tree, "name"), "edit-value");
    const input = tree.querySelector<HTMLInputElement>("[data-tree-edit-input]")!;
    expect(input.value).toBe("Ann");
    input.value = "Annie";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flushUi();
    expect(backend.documentUpdateDocument).toHaveBeenCalledTimes(1);
    const [, , collection, , update] = backend.documentUpdateDocument.mock.calls[0]!;
    expect(collection).toBe("people");
    expect(JSON.parse(update as string)).toEqual({ $set: { name: "Annie" } });
    expect(tree.querySelector("[data-tree-edit-input]")).toBeNull();
    expect(rowByKey(tree, "name").textContent).toContain("Annie");
  });
});
