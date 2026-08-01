// @vitest-environment happy-dom

import { createApp, nextTick, type App, type ComputedRef, type InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  getColumns: vi.fn(),
  documentFindDocuments: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: backend.getColumns,
  documentFindDocuments: backend.documentFindDocuments,
  cancelQuery: backend.cancelQuery,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: backend.ensureConnected,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      pageSize: 100,
      mongoViewMode: "table",
    },
    updateEditorSettings: vi.fn(),
  }),
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
