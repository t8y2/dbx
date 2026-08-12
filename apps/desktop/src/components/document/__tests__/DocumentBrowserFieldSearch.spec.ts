// @vitest-environment happy-dom

import { createApp, nextTick, type App, type ComputedRef, type InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  getColumns: vi.fn(),
  documentFindDocuments: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  documentDeleteDocument: vi.fn(),
}));

const documentJsonEditor = vi.hoisted(() => ({
  openSearch: vi.fn().mockReturnValue(true),
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
  },
  updateEditorSettings: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: backend.getColumns,
  documentFindDocuments: backend.documentFindDocuments,
  cancelQuery: backend.cancelQuery,
  documentDeleteDocument: backend.documentDeleteDocument,
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

vi.mock("@/components/grid/DataGrid.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "DataGridStub",
      inheritAttrs: false,
      props: {
        result: { type: Object, required: true },
        connectionId: { type: String, default: "" },
        database: { type: String, default: "" },
        columnLayoutScopeKey: { type: String, default: "" },
      },
      setup(props, { expose, slots }) {
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
        return () =>
          h(
            "div",
            {
              "data-testid": "data-grid",
              "data-connection-id": props.connectionId,
              "data-database": props.database,
              "data-column-layout-scope-key": props.columnLayoutScopeKey,
              "data-result-hidden-column-keys": JSON.stringify((props.result as { local_hidden_column_keys?: string[] }).local_hidden_column_keys ?? []),
              "data-result-column-types": JSON.stringify((props.result as { column_types?: string[] }).column_types ?? []),
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
    setup(props, { slots }) {
      return () => h("div", { "data-testid": "select", "data-model-value": props.modelValue }, slots.default?.());
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
  backend.cancelQuery.mockReset();
  backend.ensureConnected.mockReset();
  backend.documentDeleteDocument.mockReset();
  documentJsonEditor.openSearch.mockClear();
  backend.documentDeleteDocument.mockResolvedValue(undefined);
  settings.editorSettings.mongoViewMode = "table";
  settings.editorSettings.columnWidthDensity = "standard";
  settings.editorSettings.dataGridRenderMode = "canvas";
  settings.editorSettings.tableFontFamily = "system-ui";
  settings.editorSettings.tableFontSize = 12;
  settings.editorSettings.numericColumnRightAlign = true;
  settings.editorSettings.confirmDangerousSqlExecution = true;
  settings.updateEditorSettings.mockReset();
  settings.updateEditorSettings.mockImplementation((partial: Partial<typeof settings.editorSettings>) => Object.assign(settings.editorSettings, partial));
  backend.ensureConnected.mockResolvedValue(undefined);
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
});
