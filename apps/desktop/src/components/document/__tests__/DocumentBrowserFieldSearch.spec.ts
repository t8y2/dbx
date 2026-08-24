// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App, type ComputedRef, type InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  getColumns: vi.fn(),
  documentFindDocuments: vi.fn(),
  documentCountDocuments: vi.fn(),
  dynamodbDescribeTable: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  documentInsertDocument: vi.fn(),
  documentUpdateDocument: vi.fn(),
  documentDeleteDocument: vi.fn(),
  documentSaveMeilisearchBatch: vi.fn(),
}));

const documentJsonEditor = vi.hoisted(() => ({
  openSearch: vi.fn().mockReturnValue(true),
}));

const dataGrid = vi.hoisted(() => ({
  fullExportResult: undefined as
    | ((onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => Promise<
        | {
            columns: string[];
            column_types?: string[];
            rows: Array<Array<string | number | boolean | null>>;
            mongo_copy_documents?: unknown[];
            truncated?: boolean;
            has_more?: boolean;
          }
        | undefined
      >)
    | undefined,
  customSaveHandler: undefined as
    | {
        save: (changes: { dirtyRows: Map<number, Map<number, unknown>>; deletedRows: Set<number>; newRows: unknown[][]; newRowMeta: unknown[]; columns: string[]; rows: unknown[][] }) => Promise<void>;
        preview?: (changes: { dirtyRows: Map<number, Map<number, unknown>>; deletedRows: Set<number>; newRows: unknown[][]; newRowMeta: unknown[]; columns: string[]; rows: unknown[][] }) => Promise<string[]>;
      }
    | undefined,
  countTotalRows: undefined as (() => Promise<number | undefined>) | undefined,
  paginate: undefined as ((offset: number, limit: number) => Promise<void>) | undefined,
  editable: true,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 100,
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
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (key === "dynamodb.items" ? `${params?.count} Items` : key),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: backend.getColumns,
  documentFindDocuments: backend.documentFindDocuments,
  documentCountDocuments: backend.documentCountDocuments,
  dynamodbDescribeTable: backend.dynamodbDescribeTable,
  cancelQuery: backend.cancelQuery,
  documentInsertDocument: backend.documentInsertDocument,
  documentUpdateDocument: backend.documentUpdateDocument,
  documentDeleteDocument: backend.documentDeleteDocument,
  documentSaveMeilisearchBatch: backend.documentSaveMeilisearchBatch,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: backend.ensureConnected,
  }),
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
        connectionId: { type: String, default: "" },
        database: { type: String, default: "" },
        columnLayoutScopeKey: { type: String, default: "" },
        fullExportResult: { type: Function, default: undefined },
        customSaveHandler: { type: Object, default: undefined },
        countTotalRows: { type: Function, default: undefined },
        editable: { type: Boolean, default: false },
      },
      setup(props, { attrs, expose, slots }) {
        dataGrid.fullExportResult = props.fullExportResult as typeof dataGrid.fullExportResult;
        dataGrid.customSaveHandler = props.customSaveHandler as typeof dataGrid.customSaveHandler;
        dataGrid.countTotalRows = props.countTotalRows as typeof dataGrid.countTotalRows;
        dataGrid.paginate = attrs.onPaginate as typeof dataGrid.paginate;
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
        });
        return () => {
          dataGrid.editable = props.editable;
          return h(
            "div",
            {
              "data-testid": "data-grid",
              "data-connection-id": props.connectionId,
              "data-database": props.database,
              "data-column-layout-scope-key": props.columnLayoutScopeKey,
              "data-result-hidden-column-keys": JSON.stringify((props.result as { local_hidden_column_keys?: string[] }).local_hidden_column_keys ?? []),
              "data-result-column-types": JSON.stringify((props.result as { column_types?: string[] }).column_types ?? []),
              "data-result-rows": JSON.stringify((props.result as { rows?: unknown[] }).rows ?? []),
              "data-editable": String(props.editable),
            },
            [
              slots["search-bar"]?.({
                localFilterCount: 0,
                hasLocalColumnFilters: false,
                localFilterSummaries: [],
                clearLocalFilter: vi.fn(),
              }),
            ],
          );
        };
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        modelValue: { type: String, required: true },
        readOnly: { type: Boolean, default: false },
        lineNumbers: { type: Boolean, default: true },
        presentation: { type: String, default: "editor" },
      },
      setup(props, { expose }) {
        expose({ openSearch: documentJsonEditor.openSearch });
        return () => h("div", { "data-redis-json-editor-stub": "", "data-read-only": String(props.readOnly), "data-line-numbers": String(props.lineNumbers), "data-presentation": props.presentation }, [h("div", { class: "cm-line" }, h("span", { class: "json-string" }, props.modelValue))]);
      },
    }),
  };
});

vi.mock("@/components/ui/popover", async () => {
  const { computed, defineComponent, h, inject, provide } = await import("vue");
  type PopoverContext = {
    open: ComputedRef<boolean>;
    setOpen(open: boolean): void;
  };
  const popoverContextKey: InjectionKey<PopoverContext> = Symbol("popover");

  const Popover = defineComponent({
    name: "PopoverStub",
    props: {
      open: { type: Boolean, default: false },
    },
    emits: ["update:open"],
    setup(props, { emit, slots }) {
      const open = computed(() => props.open);
      provide(popoverContextKey, {
        open,
        setOpen: (nextOpen) => emit("update:open", nextOpen),
      });
      return () => h("div", { "data-testid": "popover" }, slots.default?.());
    },
  });

  const PopoverTrigger = defineComponent({
    name: "PopoverTriggerStub",
    setup(_, { slots }) {
      const context = inject(popoverContextKey);
      return () =>
        h(
          "span",
          {
            "data-testid": "popover-trigger",
            onClick: () => context?.setOpen(!context.open.value),
          },
          slots.default?.(),
        );
    },
  });

  const PopoverContent = defineComponent({
    name: "PopoverContentStub",
    setup(_, { slots }) {
      const context = inject(popoverContextKey);
      return () => (context?.open.value ? h("div", { "data-testid": "popover-content" }, slots.default?.()) : null);
    },
  });

  return { Popover, PopoverTrigger, PopoverContent };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Select = defineComponent({
    name: "SelectStub",
    props: {
      modelValue: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
      return () => h("div", { "data-testid": "select", "data-model-value": props.modelValue, onClick: () => props.modelValue === "__table__" && emit("update:modelValue", "by_status") }, slots.default?.());
    },
  });
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return {
    Select,
    SelectContent: passthrough("SelectContentStub"),
    SelectItem: passthrough("SelectItemStub"),
    SelectTrigger: passthrough("SelectTriggerStub"),
    SelectValue: passthrough("SelectValueStub"),
  };
});

import DocumentBrowser from "@/components/document/DocumentBrowser.vue";
import { documentDataGridColumnLayoutScopeKey, loadDataGridColumnLayout } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { documentGridColumnVisibilityScopeKey } from "@/lib/document/documentGridColumnVisibilityStorage";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;
let storedValues: Map<string, string>;

async function flushUi() {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

function buttonWithTitle(title: string): HTMLButtonElement {
  const button = document.body.querySelector<HTMLElement>(`[title="${title}"]`)?.closest<HTMLButtonElement>("button") ?? null;
  expect(button).not.toBeNull();
  return button!;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === text);
  expect(button).toBeDefined();
  return button!;
}

function fieldTriggerButtons(title: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[title="${title}"]`)].map((label) => label.closest<HTMLButtonElement>("button")!);
}

async function setSearchInput(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]');
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await flushUi();
  return input!;
}

beforeEach(async () => {
  storedValues = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
  });
  backend.getColumns.mockReset();
  backend.documentFindDocuments.mockReset();
  backend.documentCountDocuments.mockReset();
  backend.dynamodbDescribeTable.mockReset();
  backend.cancelQuery.mockReset();
  backend.ensureConnected.mockReset();
  backend.documentInsertDocument.mockReset();
  backend.documentUpdateDocument.mockReset();
  backend.documentDeleteDocument.mockReset();
  backend.documentSaveMeilisearchBatch.mockReset();
  dataGrid.fullExportResult = undefined;
  dataGrid.customSaveHandler = undefined;
  dataGrid.countTotalRows = undefined;
  dataGrid.paginate = undefined;
  dataGrid.editable = true;
  documentJsonEditor.openSearch.mockClear();
  backend.documentDeleteDocument.mockResolvedValue(undefined);
  backend.documentInsertDocument.mockResolvedValue("created");
  backend.documentUpdateDocument.mockResolvedValue(1);
  backend.documentSaveMeilisearchBatch.mockResolvedValue(0);
  settings.editorSettings.mongoViewMode = "table";
  settings.editorSettings.columnWidthDensity = "standard";
  settings.editorSettings.dataGridRenderMode = "canvas";
  settings.editorSettings.tableFontFamily = "system-ui";
  settings.editorSettings.tableFontSize = 12;
  settings.editorSettings.numericColumnRightAlign = true;
  settings.editorSettings.confirmDangerousSqlExecution = true;
  settings.editorSettings.exportBatchSize = 2;
  settings.editorSettings.exportRowLimitEnabled = false;
  settings.editorSettings.exportRowLimit = 100_000;
  settings.updateEditorSettings.mockReset();
  settings.updateEditorSettings.mockImplementation((partial: Partial<typeof settings.editorSettings>) => Object.assign(settings.editorSettings, partial));
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(0);
  backend.dynamodbDescribeTable.mockResolvedValue({
    name: "orders",
    status: "ACTIVE",
    itemCount: 0,
    sizeBytes: 0,
    partitionKey: { name: "tenant_id", attributeType: "S" },
    sortKey: { name: "order_id", attributeType: "S" },
    indexes: [],
  });
  backend.getColumns.mockResolvedValue([
    { name: "buyers", data_type: "nested" },
    { name: "buyers.email", data_type: "text" },
    { name: "buyers.email.keyword", data_type: "keyword" },
    { name: "title", data_type: "text" },
    { name: "title.keyword", data_type: "keyword" },
  ]);
  backend.documentFindDocuments.mockResolvedValue({
    documents: [{ _id: "document-1", title: "Example" }],
    raw_documents: [],
    total: 1,
    total_is_exact: true,
  });

  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(DocumentBrowser, {
    connectionId: "connection-1",
    database: "",
    collection: "orders",
    databaseType: "elasticsearch",
  });
  app.mount(root);
  await flushUi();
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DocumentBrowser Elasticsearch field search", () => {
  it("migrates hidden columns and passes a stable index layout scope without changing the query result", async () => {
    app?.unmount();
    const legacyScopeKey = documentGridColumnVisibilityScopeKey({
      databaseType: "elasticsearch",
      connectionId: "connection-1",
      database: "",
      collection: "orders",
    });
    const layoutScopeKey = documentDataGridColumnLayoutScopeKey({
      databaseType: "elasticsearch",
      connectionId: "connection-1",
      database: "",
      collection: "orders",
    });
    storedValues.set(`dbx-document-grid-column-visibility:v1:${legacyScopeKey}`, JSON.stringify(["title"]));

    app = createApp(DocumentBrowser, {
      connectionId: "connection-1",
      database: "",
      collection: "orders",
      databaseType: "elasticsearch",
    });
    app.mount(root!);
    await flushUi();

    const dataGrid = root!.querySelector<HTMLElement>('[data-testid="data-grid"]')!;
    expect(dataGrid.dataset.connectionId).toBe("connection-1");
    expect(dataGrid.dataset.database).toBe("");
    expect(dataGrid.dataset.columnLayoutScopeKey).toBe(layoutScopeKey);
    expect(dataGrid.dataset.resultHiddenColumnKeys).toBe("[]");
    expect(loadDataGridColumnLayout(layoutScopeKey)).toEqual({ orderKeys: [], hiddenKeys: ["title"] });
  });

  it("searches, selects, updates the query type, and clears the search when closed", async () => {
    root!.querySelector<HTMLButtonElement>('[data-testid="data-grid"] button')!.click();
    await flushUi();

    const initialFieldTrigger = buttonWithTitle("buyers.email (text)");
    expect(document.body.querySelector('[data-testid="select"][data-model-value="match"]')).not.toBeNull();
    initialFieldTrigger.click();
    await flushUi();

    const focusedSearch = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]');
    expect(document.activeElement).toBe(focusedSearch);
    expect(buttonWithText("buyers").disabled).toBe(true);

    await setSearchInput("missing.field");
    expect(document.body.textContent).toContain("grid.noSearchResults");

    await setSearchInput(" BUYERS.EMAIL.KEYWORD ");
    const resultButton = buttonWithText("buyers.email.keyword (keyword)");
    expect(document.body.textContent).not.toContain("title.keyword (keyword)");

    resultButton.click();
    await flushUi();

    const selectedFieldTrigger = buttonWithTitle("buyers.email.keyword (keyword)");
    expect(document.body.querySelector('[data-testid="select"][data-model-value="term"]')).not.toBeNull();

    selectedFieldTrigger.click();
    await flushUi();
    const reopenedSearch = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]');
    expect(reopenedSearch?.value).toBe("");
  });

  it("clears each rule search independently when its field popover closes", async () => {
    root!.querySelector<HTMLButtonElement>('[data-testid="data-grid"] button')!.click();
    await flushUi();
    buttonWithText("grid.filterBuilderAddRule").click();
    await flushUi();

    const fieldTriggers = fieldTriggerButtons("buyers.email (text)");
    expect(fieldTriggers).toHaveLength(2);

    fieldTriggers[0].click();
    await flushUi();
    await setSearchInput("title");
    fieldTriggers[0].click();
    await flushUi();

    fieldTriggers[1].click();
    await flushUi();
    const secondSearch = await setSearchInput("keyword");
    expect(secondSearch.value).toBe("keyword");
    fieldTriggers[1].click();
    await flushUi();

    fieldTriggers[0].click();
    await flushUi();
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]')?.value).toBe("");
    fieldTriggers[0].click();
    await flushUi();

    fieldTriggers[1].click();
    await flushUi();
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]')?.value).toBe("");
  });
});

describe("DocumentBrowser MongoDB filter value types", () => {
  it("loads DynamoDB table metadata before requesting the first page", async () => {
    app?.unmount();
    let resolveDescription!: (value: { name: string; status: string; itemCount: number; sizeBytes: number; partitionKey: { name: string; attributeType: string }; sortKey: { name: string; attributeType: string }; indexes: never[] }) => void;
    backend.dynamodbDescribeTable.mockReturnValue(
      new Promise((resolve) => {
        resolveDescription = resolve;
      }),
    );
    backend.documentFindDocuments.mockClear();
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    expect(backend.dynamodbDescribeTable).toHaveBeenCalledOnce();
    expect(backend.documentFindDocuments).not.toHaveBeenCalled();

    resolveDescription({
      name: "orders",
      status: "ACTIVE",
      itemCount: 0,
      sizeBytes: 0,
      partitionKey: { name: "tenant_id", attributeType: "S" },
      sortKey: { name: "order_id", attributeType: "S" },
      indexes: [],
    });
    await flushUi();

    expect(backend.documentFindDocuments).toHaveBeenCalledOnce();
  });

  it("labels new DynamoDB rows as conditional inserts in the executable preview", async () => {
    app?.unmount();
    backend.documentFindDocuments.mockResolvedValue({
      documents: [{ _id: { tenant_id: "tenant-04", order_id: "ORD-000994" }, tenant_id: "tenant-04", order_id: "ORD-000994", note: "existing" }],
      total: 1,
      total_is_exact: true,
    });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    const preview = await dataGrid.customSaveHandler!.preview!({
      dirtyRows: new Map(),
      deletedRows: new Set(),
      newRows: [['{"tenant_id":"tenant-04","order_id":"ORD-new"}', "tenant-04", "ORD-new", "new item"]],
      newRowMeta: [{}],
      columns: ["_id", "tenant_id", "order_id", "note"],
      rows: [['{"tenant_id":"tenant-04","order_id":"ORD-000994"}', "tenant-04", "ORD-000994", "existing"]],
    });

    expect(preview).toHaveLength(1);
    expect(preview[0]).toContain('DBX DYNAMODB INSERT ITEM\ntable: "orders"');
    expect(preview[0]).toContain('"order_id": "ORD-new"');
  });

  it("uses one backend update for a DynamoDB key migration and previews the old source key", async () => {
    app?.unmount();
    backend.documentFindDocuments.mockResolvedValue({
      documents: [{ _id: { tenant_id: "tenant-04", order_id: "ORD-old" }, tenant_id: "tenant-04", order_id: "ORD-old", note: "existing" }],
      total: 1,
      total_is_exact: true,
    });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    const changes = {
      dirtyRows: new Map([[0, new Map([[2, "ORD-new"]])]]),
      deletedRows: new Set<number>(),
      newRows: [],
      newRowMeta: [],
      columns: ["_id", "tenant_id", "order_id", "note"],
      rows: [['{"tenant_id":"tenant-04","order_id":"ORD-old"}', "tenant-04", "ORD-old", "existing"]],
    };
    const preview = await dataGrid.customSaveHandler!.preview!(changes);

    expect(preview).toHaveLength(1);
    expect(preview[0]).toContain('key:\n{\n  "tenant_id": "tenant-04",\n  "order_id": "ORD-old"\n}');
    expect(preview[0]).toContain('"order_id": "ORD-new"');

    await dataGrid.customSaveHandler!.save(changes);
    expect(backend.documentUpdateDocument).toHaveBeenCalledTimes(1);
    expect(backend.documentUpdateDocument.mock.calls[0]?.slice(0, 4)).toEqual(["dynamodb-1", "us-east-1", "orders", '{"tenant_id":"tenant-04","order_id":"ORD-old"}']);
    expect(JSON.parse(backend.documentUpdateDocument.mock.calls[0]?.[4])).toMatchObject({ tenant_id: "tenant-04", order_id: "ORD-new", note: "existing" });
    expect(backend.documentInsertDocument).not.toHaveBeenCalled();
    expect(backend.documentDeleteDocument).not.toHaveBeenCalled();
  });

  it("makes partial-projection DynamoDB index results read-only", async () => {
    app?.unmount();
    backend.dynamodbDescribeTable.mockResolvedValue({
      name: "orders",
      status: "ACTIVE",
      itemCount: 1,
      sizeBytes: 100,
      partitionKey: { name: "tenant_id", attributeType: "S" },
      sortKey: { name: "order_id", attributeType: "S" },
      indexes: [
        {
          name: "by_status",
          kind: "global",
          partitionKey: { name: "status", attributeType: "S" },
          sortKey: { name: "created_at", attributeType: "N" },
          projectionType: "KEYS_ONLY",
          nonKeyAttributes: [],
        },
      ],
    });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    expect(dataGrid.editable).toBe(true);
    root!.querySelector<HTMLElement>('[data-testid="select"][data-model-value="__table__"]')!.click();
    await flushUi();

    expect(dataGrid.editable).toBe(false);
    expect(root!.textContent).toContain("KEYS_ONLY");
    await expect(
      dataGrid.customSaveHandler!.save({
        dirtyRows: new Map(),
        deletedRows: new Set(),
        newRows: [],
        newRowMeta: [],
        columns: ["_id"],
        rows: [],
      }),
    ).rejects.toThrow("dynamodb.partialProjectionReadOnly");
  });

  it("keeps ALL-projection DynamoDB index results editable", async () => {
    app?.unmount();
    backend.dynamodbDescribeTable.mockResolvedValue({
      name: "orders",
      status: "ACTIVE",
      itemCount: 1,
      sizeBytes: 100,
      partitionKey: { name: "tenant_id", attributeType: "S" },
      sortKey: { name: "order_id", attributeType: "S" },
      indexes: [
        {
          name: "by_status",
          kind: "global",
          partitionKey: { name: "status", attributeType: "S" },
          sortKey: { name: "created_at", attributeType: "N" },
          projectionType: "ALL",
          nonKeyAttributes: [],
        },
      ],
    });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    root!.querySelector<HTMLElement>('[data-testid="select"][data-model-value="__table__"]')!.click();
    await flushUi();
    expect(dataGrid.editable).toBe(true);
  });

  it("keeps an exact DynamoDB count while moving between cursor pages", async () => {
    app?.unmount();
    backend.documentCountDocuments.mockResolvedValue(250);
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments
      .mockResolvedValueOnce({
        documents: Array.from({ length: 100 }, (_, index) => ({ _id: { tenant_id: "tenant-a", order_id: String(index) } })),
        total: 101,
        total_is_exact: false,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        documents: Array.from({ length: 100 }, (_, index) => ({ _id: { tenant_id: "tenant-a", order_id: String(index + 100) } })),
        total: 101,
        total_is_exact: false,
        next_cursor: "cursor-2",
      });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    expect(await dataGrid.countTotalRows!()).toBe(250);
    await flushUi();
    expect(root!.textContent).toContain("250 Items");

    await dataGrid.paginate!(100, 100);
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls.at(-1)?.[10]).toBe("cursor-1");
    expect(root!.textContent).toContain("250 Items");
  });

  it("exports all DynamoDB pages with opaque cursors instead of offsets", async () => {
    app?.unmount();
    settings.editorSettings.exportBatchSize = 2;
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments
      .mockResolvedValueOnce({
        documents: [{ _id: { tenant_id: "tenant-a", order_id: "visible" }, tenant_id: "tenant-a", order_id: "visible" }],
        total: 2,
        total_is_exact: false,
        next_cursor: "visible-cursor",
      })
      .mockResolvedValueOnce({
        documents: [
          { _id: { tenant_id: "tenant-a", order_id: "001" }, tenant_id: "tenant-a", order_id: "001", amount: { $dbxDynamoDb: { version: 1, type: "number", value: "9007199254740993" } } },
          { _id: { tenant_id: "tenant-a", order_id: "002" }, tenant_id: "tenant-a", order_id: "002", tags: { $dbxDynamoDb: { version: 1, type: "stringSet", value: ["new", "paid"] } } },
        ],
        total: 3,
        total_is_exact: false,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        documents: [{ _id: { tenant_id: "tenant-b", order_id: "003" }, tenant_id: "tenant-b", order_id: "003" }],
        total: 1,
        total_is_exact: true,
      });
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    expect(dataGrid.fullExportResult).toBeTypeOf("function");
    const progress = vi.fn();
    const result = await dataGrid.fullExportResult!(progress);

    expect(backend.documentFindDocuments.mock.calls.slice(1).map((call) => [call[3], call[4], call[10]])).toEqual([
      [0, 2, undefined],
      [0, 2, "cursor-1"],
    ]);
    expect(result?.rows).toHaveLength(3);
    expect(result?.rows[0]).toContain('{"$dbxDynamoDb":{"version":1,"type":"number","value":"9007199254740993"}}');
    expect(result?.rows[1]).toContain('{"$dbxDynamoDb":{"version":1,"type":"stringSet","value":["new","paid"]}}');
    expect(progress).toHaveBeenLastCalledWith({ rowsExported: 3, totalRows: 3 });
  });

  it("caps an otherwise unlimited DynamoDB export at 10,000 items", async () => {
    app?.unmount();
    settings.editorSettings.exportBatchSize = 1000;
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValueOnce({
      documents: [{ _id: { tenant_id: "visible", order_id: "visible" } }],
      total: 2,
      total_is_exact: false,
      next_cursor: "visible-cursor",
    });
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      backend.documentFindDocuments.mockResolvedValueOnce({
        documents: Array.from({ length: 1000 }, (_, rowIndex) => ({
          _id: { tenant_id: `tenant-${pageIndex}`, order_id: String(rowIndex) },
          tenant_id: `tenant-${pageIndex}`,
          order_id: String(rowIndex),
        })),
        total: 1001,
        total_is_exact: false,
        next_cursor: `cursor-${pageIndex + 1}`,
      });
    }
    app = createApp(DocumentBrowser, {
      connectionId: "dynamodb-1",
      database: "us-east-1",
      collection: "orders",
      databaseType: "dynamodb",
    });
    app.mount(root!);
    await flushUi();

    const progress = vi.fn();
    const result = await dataGrid.fullExportResult!(progress);

    expect(result?.rows).toHaveLength(10_000);
    expect(result?.truncated).toBe(true);
    expect(result?.has_more).toBe(true);
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(11);
    expect(progress).toHaveBeenLastCalledWith({ rowsExported: 10_000, totalRows: null });
  });

  it("exports all matching MongoDB documents without changing the visible page", async () => {
    app?.unmount();
    settings.editorSettings.exportBatchSize = 2;
    settings.editorSettings.exportRowLimitEnabled = true;
    settings.editorSettings.exportRowLimit = 3;
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments
      .mockResolvedValueOnce({
        documents: [{ _id: "visible", name: "Visible" }],
        extended_documents: [{ _id: { $oid: "000000000000000000000001" }, name: "Visible" }],
        total: 5,
        total_is_exact: true,
      })
      .mockResolvedValueOnce({
        documents: [
          { _id: "one", name: "First" },
          { _id: "two", name: "Second" },
        ],
        extended_documents: [
          { _id: { $oid: "000000000000000000000002" }, name: "First" },
          { _id: { $oid: "000000000000000000000003" }, name: "Second" },
        ],
        total: 5,
        total_is_exact: true,
      })
      .mockResolvedValueOnce({
        documents: [{ _id: "three", later: { $numberLong: "9007199254740993" } }],
        extended_documents: [{ _id: { $oid: "000000000000000000000004" }, later: { $numberLong: "9007199254740993" } }],
        total: 5,
        total_is_exact: true,
      });
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "orders",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    const inputs = root!.querySelectorAll<HTMLTextAreaElement>("textarea");
    inputs[0]!.value = '{"active":true}';
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1]!.value = '{"createdAt":-1}';
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    expect(dataGrid.fullExportResult).toBeTypeOf("function");
    const progress = vi.fn();
    const result = await dataGrid.fullExportResult!(progress);

    expect(backend.documentFindDocuments.mock.calls.slice(1).map((call) => call.slice(0, 9))).toEqual([
      ["mongo-1", "test", "orders", 0, 2, '{"active":true}', undefined, '{"createdAt":-1}', undefined],
      ["mongo-1", "test", "orders", 2, 1, '{"active":true}', undefined, '{"createdAt":-1}', undefined],
    ]);
    expect(result?.columns).toEqual(["_id", "name", "later"]);
    expect(result?.rows).toEqual([
      ["one", "First", null],
      ["two", "Second", null],
      ["three", null, "9007199254740993"],
    ]);
    expect(result?.mongo_copy_documents).toEqual([
      { _id: { $oid: "000000000000000000000002" }, name: "First" },
      { _id: { $oid: "000000000000000000000003" }, name: "Second" },
      { _id: { $oid: "000000000000000000000004" }, later: { $numberLong: "9007199254740993" } },
    ]);
    expect(progress).toHaveBeenLastCalledWith({ rowsExported: 3, totalRows: 3 });
    const visibleGrid = root!.querySelector<HTMLElement>('[data-testid="data-grid"]')!;
    expect(JSON.parse(visibleGrid.dataset.resultColumnTypes ?? "[]")).toEqual(["", ""]);
    expect(JSON.parse(visibleGrid.dataset.resultRows ?? "[]")).toEqual([["visible", "Visible"]]);
    expect(inputs[0]!.value).toBe('{"active":true}');
    expect(inputs[1]!.value).toBe('{"createdAt":-1}');
  });

  it("stops MongoDB full export on a short page when the total is estimated", async () => {
    app?.unmount();
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValueOnce({ documents: [{ _id: "visible" }], total: 500, total_is_exact: false }).mockResolvedValueOnce({ documents: [{ _id: "only" }], total: 500, total_is_exact: false });
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "orders",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    const progress = vi.fn();
    const result = await dataGrid.fullExportResult!(progress);

    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(2);
    expect(result?.rows).toEqual([["only"]]);
    expect(progress).toHaveBeenLastCalledWith({ rowsExported: 1, totalRows: null });
  });

  it("does not offer the MongoDB full export callback to Elasticsearch viewers", () => {
    expect(dataGrid.fullExportResult).toBeUndefined();
  });

  it("identifies consistently numeric MongoDB columns for shared grid alignment", async () => {
    app?.unmount();
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValue({
      documents: [
        { _id: "001", amount: 12.5, stringId: "123", mixed: 1, counter: { $numberLong: "9007199254740993" }, optional: null },
        { _id: "002", amount: 8, stringId: "456", mixed: "2", counter: { $numberLong: "9007199254740994" } },
      ],
      raw_documents: [],
      total: 2,
      total_is_exact: true,
    });
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_values",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    const dataGrid = root!.querySelector<HTMLElement>('[data-testid="data-grid"]')!;
    expect(JSON.parse(dataGrid.dataset.resultColumnTypes ?? "[]")).toEqual(["", "number", "", "", "int64", ""]);
  });

  it("shows the value type selector and preserves a sampled string _id", async () => {
    app?.unmount();
    backend.documentFindDocuments.mockReset();
    backend.documentFindDocuments.mockResolvedValue({
      documents: [{ _id: "1", title: "String id" }],
      raw_documents: [],
      total: 1,
      total_is_exact: true,
    });
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    root!.querySelector<HTMLButtonElement>('[data-testid="data-grid"] button')!.click();
    await flushUi();
    expect(document.body.querySelector('[data-testid="select"][data-model-value="auto"]')).not.toBeNull();

    const clearButton = buttonWithText("grid.clearFilter");
    const addButton = buttonWithText("grid.filterBuilderAddRule");
    expect(clearButton.className).toContain("h-7");
    expect(clearButton.querySelector(".lucide-trash-2")).not.toBeNull();
    expect(clearButton.parentElement?.firstElementChild?.textContent).toContain("grid.filter");
    expect(addButton.className).toContain("h-7");
    expect(addButton.querySelector(".lucide-plus")).not.toBeNull();
    expect(addButton.parentElement?.firstElementChild).toBe(addButton);
    expect(clearButton.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const removeButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.disabled && button.querySelector(".lucide-x"));
    expect(removeButton?.className).toContain("h-7");
    expect(removeButton?.className).toContain("w-7");

    const valueInput = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderValue"]');
    expect(valueInput).not.toBeNull();
    valueInput!.value = "1";
    valueInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    buttonWithText("grid.applyFilter").click();
    await flushUi();

    const filter = backend.documentFindDocuments.mock.calls.at(-1)?.[5];
    expect(JSON.parse(filter)).toEqual({ _id: "1" });
  });

  it("exposes the applicable shared table view options", async () => {
    app?.unmount();
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    buttonWithTitle("grid.viewOptions").click();
    await flushUi();
    expect(document.body.textContent).toContain("grid.renderMode");
    expect(document.body.textContent).toContain("grid.tableFontFamily");
    expect(document.body.textContent).toContain("grid.tableFontSize");
    expect(document.body.textContent).toContain("grid.transposeMultiRowToggle");
    expect(document.body.textContent).toContain("grid.numericColumnAlign");

    buttonWithText("grid.columnWidthCompact").click();
    expect(settings.updateEditorSettings).toHaveBeenCalledWith({ columnWidthDensity: "compact" });

    buttonWithText("grid.domRenderMode").click();
    expect(settings.updateEditorSettings).toHaveBeenCalledWith({ dataGridRenderMode: "dom" });

    buttonWithText("grid.numericColumnAlignLeft").click();
    expect(settings.updateEditorSettings).toHaveBeenCalledWith({ numericColumnRightAlign: false });

    document.body.querySelector<HTMLButtonElement>('[aria-label="common.increase"]')!.click();
    expect(settings.updateEditorSettings).toHaveBeenCalledWith({ tableFontSize: 13 });
  });

  it("matches SQL value keyboard shortcuts and ignores IME confirmation Enter", async () => {
    app?.unmount();
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    root!.querySelector<HTMLButtonElement>('[data-testid="data-grid"] button')!.click();
    await flushUi();
    const valueInput = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderValue"]')!;
    const callsBeforeEnter = backend.documentFindDocuments.mock.calls.length;
    valueInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls.length).toBeGreaterThan(callsBeforeEnter);

    root!.querySelector<HTMLButtonElement>('[data-testid="data-grid"] button')!.click();
    await flushUi();
    const reopenedValueInput = document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderValue"]')!;
    reopenedValueInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await flushUi();
    expect(document.body.querySelectorAll('input[placeholder="grid.filterBuilderValue"]')).toHaveLength(2);
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="grid.filterBuilderSearchColumns"]')).not.toBeNull();

    const callsBeforeCompositionEnter = backend.documentFindDocuments.mock.calls.length;
    reopenedValueInput.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    reopenedValueInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flushUi();
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(callsBeforeCompositionEnter);
  });

  it("enters document editing only when double-clicking viewer whitespace", async () => {
    app?.unmount();
    settings.editorSettings.mongoViewMode = "document";
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    const documentBrowser = app.mount(root!) as unknown as { focusSearch: () => boolean };
    await flushUi();

    const documentRow = [...root!.querySelectorAll<HTMLElement>(".group")].find((element) => element.textContent?.includes("document-1"))!;
    documentRow.click();
    await flushUi();

    const viewer = root!.querySelector<HTMLElement>("[data-document-json-viewer]")!;
    const jsonText = viewer.querySelector<HTMLElement>(".cm-line .json-string")!;
    const documentId = root!.querySelector<HTMLInputElement>('input[aria-label^="_id:"]')!;
    expect(root!.firstElementChild?.classList.contains("select-none")).toBe(true);
    expect(documentId.readOnly).toBe(true);
    expect(documentId.value).toBe("document-1");
    expect(documentId.classList.contains("select-text")).toBe(true);
    const documentIdBadge = documentId.closest<HTMLElement>('[data-slot="badge"]');
    expect(documentIdBadge).not.toBeNull();
    expect(documentIdBadge?.classList.contains("rounded")).toBe(true);
    expect(documentIdBadge?.classList.contains("rounded-4xl")).toBe(false);
    expect(viewer.querySelector<HTMLElement>("[data-redis-json-editor-stub]")?.dataset.readOnly).toBe("true");
    expect(viewer.querySelector<HTMLElement>("[data-redis-json-editor-stub]")?.dataset.lineNumbers).toBe("false");
    expect(viewer.querySelector<HTMLElement>("[data-redis-json-editor-stub]")?.dataset.presentation).toBe("viewer");

    documentId.setSelectionRange(0, documentId.value.length);
    expect(documentId.selectionStart).toBe(0);
    expect(documentId.selectionEnd).toBe(documentId.value.length);
    expect(window.getSelection()?.toString()).toBe("");

    jsonText.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushUi();
    expect(buttonWithText("mongo.edit")).toBeDefined();

    viewer.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(documentBrowser.focusSearch()).toBe(true);
    expect(documentJsonEditor.openSearch).toHaveBeenCalledOnce();

    viewer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushUi();
    expect(buttonWithText("grid.save")).toBeDefined();
  });

  it("deletes a document without opening the danger dialog when confirmation is disabled", async () => {
    app?.unmount();
    settings.editorSettings.mongoViewMode = "document";
    settings.editorSettings.confirmDangerousSqlExecution = false;
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    root!.querySelector<HTMLElement>(".lucide-trash-2")!.closest<HTMLButtonElement>("button")!.click();
    await flushUi();

    expect(backend.documentDeleteDocument).toHaveBeenCalledOnce();
    expect(backend.documentDeleteDocument).toHaveBeenCalledWith("mongo-1", "test", "typed_ids", '__dbx_mongo_string_id__"document-1"', undefined, undefined);
  });

  it("waits for danger confirmation before deleting a document when confirmation is enabled", async () => {
    app?.unmount();
    settings.editorSettings.mongoViewMode = "document";
    settings.editorSettings.confirmDangerousSqlExecution = true;
    app = createApp(DocumentBrowser, {
      connectionId: "mongo-1",
      database: "test",
      collection: "typed_ids",
      databaseType: "mongodb",
    });
    app.mount(root!);
    await flushUi();

    root!.querySelector<HTMLElement>(".lucide-trash-2")!.closest<HTMLButtonElement>("button")!.click();
    await flushUi();

    expect(backend.documentDeleteDocument).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("dangerDialog.deleteMessage");
  });

  it("saves Meilisearch grid changes in one batch request", async () => {
    app?.unmount();
    backend.getColumns.mockResolvedValue([
      { name: "id", data_type: "string", is_primary_key: true },
      { name: "title", data_type: "string" },
      { name: "rating", data_type: "number" },
      { name: "obsolete", data_type: "boolean" },
    ]);
    backend.documentFindDocuments.mockResolvedValue({
      documents: [
        { _id: "001", title: "One", rating: 1, obsolete: true },
        { _id: 2, title: "Two", rating: 2, obsolete: false },
        { _id: 3, title: "Three", rating: 3, obsolete: false },
      ],
      raw_documents: [],
      total: 3,
      total_is_exact: true,
    });
    backend.documentSaveMeilisearchBatch.mockResolvedValue(4);
    app = createApp(DocumentBrowser, {
      connectionId: "meili-1",
      database: "default",
      collection: "movies",
      databaseType: "meilisearch",
    });
    app.mount(root!);
    await flushUi();

    expect(dataGrid.customSaveHandler).toBeDefined();
    await dataGrid.customSaveHandler!.save({
      dirtyRows: new Map([
        [
          0,
          new Map([
            [1, "One revised"],
            [3, null],
          ]),
        ],
      ]),
      deletedRows: new Set([2]),
      newRows: [
        ["004", "Four", 4, false],
        [null, "Generated", 5, true],
      ],
      newRowMeta: [{}, {}],
      columns: ["_id", "title", "rating", "obsolete"],
      rows: [
        ["001", "One", 1, true],
        [2, "Two", 2, false],
        [3, "Three", 3, false],
      ],
    });

    expect(backend.documentSaveMeilisearchBatch).toHaveBeenCalledOnce();
    const [connectionId, collection, updates, deleteIds, inserts] = backend.documentSaveMeilisearchBatch.mock.calls[0]!;
    expect(connectionId).toBe("meili-1");
    expect(collection).toBe("movies");
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('__dbx_meilisearch_string_id__"001"');
    expect(JSON.parse(updates[0].docJson)).toEqual({ title: "One revised", rating: 1 });
    expect(deleteIds).toEqual(["3"]);
    expect(inserts.map((value: string) => JSON.parse(value))).toEqual([
      { title: "Four", rating: 4, obsolete: false, _id: "004" },
      { title: "Generated", rating: 5, obsolete: true },
    ]);
  });
});
