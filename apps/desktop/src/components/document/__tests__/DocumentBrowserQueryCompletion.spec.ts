// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  documentFindDocuments: vi.fn(),
  documentCountDocuments: vi.fn(),
  getColumns: vi.fn(),
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  listMongoCompletionFields: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 50,
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
  getColumns: backend.getColumns,
  documentFindDocuments: backend.documentFindDocuments,
  documentCountDocuments: backend.documentCountDocuments,
  dynamodbDescribeTable: vi.fn(),
  cancelQuery: backend.cancelQuery,
  documentInsertDocument: vi.fn(),
  documentUpdateDocument: vi.fn(),
  documentDeleteDocument: vi.fn(),
  documentSaveMeilisearchBatch: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: backend.ensureConnected,
    listMongoCompletionFields: backend.listMongoCompletionFields,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  TABLE_FONT_SIZE_MIN: 8,
  TABLE_FONT_SIZE_MAX: 16,
  useSettingsStore: () => settings,
}));

vi.mock("@/components/grid/DataGrid.vue", () => ({
  default: defineComponent({
    name: "DataGridStub",
    inheritAttrs: false,
    props: { result: { type: Object, required: true } },
    setup(_, { expose, slots }) {
      expose({
        visibleColumnCount: 0,
        displayableColumnCount: 0,
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
        h("div", { "data-testid": "data-grid" }, [
          slots["search-bar"]?.({
            localFilterCount: 0,
            hasLocalColumnFilters: false,
            localFilterSummaries: [],
            clearLocalFilter: vi.fn(),
          }),
        ]);
    },
  }),
}));

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent: define, h: hh } = await import("vue");
  return {
    default: define({
      props: { modelValue: { type: String, required: true } },
      setup(props) {
        return () => hh("div", {}, props.modelValue);
      },
    }),
  };
});

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent: define, h: hh } = await import("vue");
  const passthrough = (name: string) =>
    define({
      name,
      setup(_, { slots }) {
        return () => hh("div", slots.default?.());
      },
    });
  return { Popover: passthrough("PopoverStub"), PopoverTrigger: passthrough("PopoverTriggerStub"), PopoverContent: passthrough("PopoverContentStub") };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent: define, h: hh } = await import("vue");
  const passthrough = (name: string) =>
    define({
      name,
      setup(_, { slots }) {
        return () => hh("div", slots.default?.());
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountBrowser(databaseType: "mongodb" | "elasticsearch" = "mongodb") {
  app = createApp(DocumentBrowser, {
    connectionId: databaseType === "mongodb" ? "mongo-1" : "es-1",
    database: "shop",
    collection: "orders",
    databaseType,
  });
  app.mount(root!);
  await flushUi();
}

/** [filter, sort] — the two query bars rendered in the grid's search slot. */
function queryInputs(): HTMLTextAreaElement[] {
  return [...root!.querySelectorAll<HTMLTextAreaElement>("textarea.document-query-input")];
}

/** `inputType` matters: the bars only open a document around an *inserted* character. */
async function typeInto(input: HTMLTextAreaElement, text: string, caret = text.length, inputType = "insertText") {
  input.value = text;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  await flushUi();
}

/** Moves the caret the way a mouse click does — no edit, so no `input` event. */
async function clickCaretTo(input: HTMLTextAreaElement, offset: number) {
  input.setSelectionRange(offset, offset);
  input.dispatchEvent(new Event("click", { bubbles: true }));
  await flushUi();
}

function pressKey(input: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

/**
 * The menu is teleported out of the grid toolbar (which clips both axes), so it
 * is only ever found on `document.body` — never under the mounted tree.
 */
function menu(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="listbox"]');
}

function menuOptions(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"] span:nth-child(2)')].map((option) => option.textContent ?? "");
}

function menuOpen(): boolean {
  return menu() !== null;
}

function selectedOption(): string | null {
  const option = document.body.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
  return option?.querySelector("span:nth-child(2)")?.textContent ?? null;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.documentCountDocuments.mockResolvedValue(0);
  backend.getColumns.mockResolvedValue([]);
  backend.documentFindDocuments.mockResolvedValue({
    documents: [
      { _id: "1", customerShippingAddress: "Beijing", createdAt: "2026-01-01" },
      { _id: "2", customerShippingAddress: "Shanghai", createdAt: "2026-01-02" },
    ],
    raw_documents: [],
    total: 2,
    total_is_exact: true,
  });
  // The store's cached sample also knows a field the loaded page happens not to show.
  backend.listMongoCompletionFields.mockResolvedValue([
    { name: "customerShippingAddress", type: "string" },
    { name: "discountCode", type: "string" },
    { name: "中文字段", type: "string" },
    { name: "客户 名", type: "string" },
  ]);

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

describe("DocumentBrowser MongoDB query bar completion (issue #9427)", () => {
  it("suggests the collection's fields as soon as the filter document is opened", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{");

    expect(menuOpen()).toBe(true);
    // Fields from the loaded page and from the store's sample, both offered.
    expect(menuOptions()).toEqual(expect.arrayContaining(["_id", "createdAt", "customerShippingAddress", "discountCode"]));
  });

  it("escapes the grid toolbar's clipping by positioning itself on the body", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{");

    // Anywhere inside the mounted tree the toolbar's `overflow-clip` would hide it.
    expect(root!.querySelector('[role="listbox"]')).toBeNull();
    expect(menu()!.parentElement).toBe(document.body);
    expect(menu()!.className).toContain("fixed");
    expect(menu()!.style.width).not.toBe("");
    expect(menu()!.style.top).not.toBe("");
  });

  it("narrows the suggestions to the typed prefix", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{ customerS");

    expect(menuOptions()).toEqual(["customerShippingAddress"]);
  });

  it("keeps completion open after an IME commits a Unicode first character", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    filter!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    filter!.value = "中";
    filter!.setSelectionRange(1, 1);
    filter!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
    await flushUi();
    expect(menuOpen()).toBe(false);

    filter!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await typeInto(filter!, "中", 1, "insertCompositionText");

    expect(filter!.value).toBe("{中}");
    expect(menuOptions()).toEqual(["中文字段"]);

    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe('{"中文字段": }');

    await typeInto(filter!, '{"中文字段": 1 }');
    pressKey(filter!, "Enter");
    await flushUi();
    expect(backend.documentFindDocuments.mock.calls.at(-1)?.[5]).toBe('{"中文字段":1}');
  });

  it("replaces a quoted field prefix containing spaces", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, '{ "客户 名');
    expect(menuOptions()).toEqual(["客户 名"]);

    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe('{ "客户 名": ');
  });

  it("completes the highlighted field on Tab and leaves the caret in value position", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, "{ customerS");

    const event = pressKey(filter!, "Tab");
    await flushUi();

    expect(event.defaultPrevented).toBe(true);
    expect(filter!.value).toBe("{ customerShippingAddress: ");
    expect(filter!.selectionStart).toBe("{ customerShippingAddress: ".length);
  });

  it("moves through the suggestions with the arrow keys", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, "{ c");

    const first = selectedOption();
    pressKey(filter!, "ArrowDown");
    await flushUi();
    const second = selectedOption();

    expect(second).not.toBe(first);
    expect(menuOptions()).toContain(second);

    pressKey(filter!, "ArrowUp");
    await flushUi();
    expect(selectedOption()).toBe(first);
  });

  it("takes the suggestion on the first Enter and runs the query on the next", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, "{ createdA");
    const callsBefore = backend.documentFindDocuments.mock.calls.length;

    pressKey(filter!, "Enter");
    await flushUi();

    expect(filter!.value).toBe("{ createdAt: ");
    expect(backend.documentFindDocuments.mock.calls.length).toBe(callsBefore);

    await typeInto(filter!, '{ createdAt: "2026-01-01" }');
    pressKey(filter!, "Enter");
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(backend.documentFindDocuments.mock.calls.at(-1)?.[5]).toBe('{"createdAt":"2026-01-01"}');
  });

  it("closes the menu on Escape and lets the next Enter run the query unchanged", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    // Caret inside the already-typed key, so the menu is open over a document
    // that is otherwise complete and runnable.
    await typeInto(filter!, '{ "createdAt": 1 }', '{ "createdAt'.length);
    expect(menuOpen()).toBe(true);
    const callsBefore = backend.documentFindDocuments.mock.calls.length;

    pressKey(filter!, "Escape");
    await flushUi();
    expect(menuOpen()).toBe(false);

    pressKey(filter!, "Enter");
    await flushUi();
    expect(filter!.value).toBe('{ "createdAt": 1 }');
    expect(backend.documentFindDocuments.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(backend.documentFindDocuments.mock.calls.at(-1)?.[5]).toBe('{"createdAt":1}');
  });

  it("runs the query on Enter when the highlighted suggestion is what is already typed", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, '{ "createdAt": 1 }', '{ "createdAt'.length);
    expect(selectedOption()).toBe("createdAt");
    const callsBefore = backend.documentFindDocuments.mock.calls.length;

    pressKey(filter!, "Enter");
    await flushUi();

    // Accepting would retype the same key, so Enter has nothing to take and the
    // query runs instead — otherwise Enter could never submit this filter.
    expect(filter!.value).toBe('{ "createdAt": 1 }');
    expect(backend.documentFindDocuments.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("replaces a quoted key in place without doubling its closing quote", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, '{ "customerS": 1 }', '{ "customerS'.length);

    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe('{ "customerShippingAddress": 1 }');
  });

  it("suggests query operators inside a field constraint", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{ createdAt: { $g");

    expect(menuOptions()).toEqual(expect.arrayContaining(["$gt", "$gte"]));
  });

  it("expands an operator snippet without leaving its editor placeholder behind", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, "{ createdAt: { $i");
    while (selectedOption() !== "$in") {
      const moved = pressKey(filter!, "ArrowDown");
      await flushUi();
      expect(moved.defaultPrevented, "ran out of suggestions before reaching $in").toBe(true);
    }

    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe("{ createdAt: { $in: []");
    expect(filter!.selectionStart).toBe("{ createdAt: { $in: [".length);
  });

  it("completes field names in the sort bar without offering query operators", async () => {
    await mountBrowser();
    const [, sort] = queryInputs();

    await typeInto(sort!, "{ c");

    expect(menuOptions()).toEqual(expect.arrayContaining(["createdAt", "customerShippingAddress"]));
    expect(menuOptions()).not.toEqual(expect.arrayContaining(["$and", "$or"]));

    pressKey(sort!, "Tab");
    await flushUi();
    expect(sort!.value).toBe("{ createdAt: ");
  });

  it("keeps Shift+Enter for a newline and Ctrl+Enter for running the query", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, '{ "createdAt": 1 }');
    const callsBefore = backend.documentFindDocuments.mock.calls.length;

    const shiftEnter = pressKey(filter!, "Enter", { shiftKey: true });
    await flushUi();
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(backend.documentFindDocuments.mock.calls.length).toBe(callsBefore);

    const ctrlEnter = pressKey(filter!, "Enter", { ctrlKey: true });
    await flushUi();
    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect(backend.documentFindDocuments.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("stays closed while an IME composition is still unconfirmed", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    // A committed key, then dismissed — so any menu that appears next can only
    // have come from the composition. Replacing that key with IME text leaves
    // the caret inside the stale model text, which is where a refresh would
    // wrongly find something to say.
    await typeInto(filter!, "{ createdAt");
    pressKey(filter!, "Escape");
    await flushUi();
    expect(menuOpen()).toBe(false);

    // v-model withholds the model until the IME commits, so a refresh here
    // would suggest against "{ createdAt" while the user is typing 收货地址.
    filter!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    filter!.value = "{ 收";
    filter!.setSelectionRange(4, 4);
    filter!.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    await flushUi();
    expect(menuOpen()).toBe(false);

    // Vue re-dispatches `input` when the composition commits, and that edit is
    // worth suggesting against.
    filter!.value = "{ c";
    filter!.setSelectionRange(3, 3);
    filter!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushUi();
    expect(menuOpen()).toBe(true);
    expect(menuOptions()).toEqual(expect.arrayContaining(["createdAt", "customerShippingAddress"]));
  });

  it("ignores an IME confirmation Enter", async () => {
    await mountBrowser();
    const [filter] = queryInputs();
    await typeInto(filter!, '{ "createdAt": 1 }');
    const callsBefore = backend.documentFindDocuments.mock.calls.length;

    pressKey(filter!, "Enter", { isComposing: true });
    await flushUi();

    expect(backend.documentFindDocuments.mock.calls.length).toBe(callsBefore);
  });

  it("says nothing once the filter document is complete", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, '{ createdAt: "2026-01-01" }');

    expect(menuOpen()).toBe(false);
  });

  it("leaves the other document stores' query bars alone", async () => {
    await mountBrowser("elasticsearch");
    const [filter] = queryInputs();

    await typeInto(filter!, "{ c");

    expect(menuOpen()).toBe(false);
    expect(backend.listMongoCompletionFields).not.toHaveBeenCalled();
  });
});

describe("DocumentBrowser MongoDB query bar completion lifecycle", () => {
  it("does not open a menu on a bar that lost focus while the fields were loading", async () => {
    // The first keystroke in a collection waits on a real backend sample, and
    // the target is only set once it resolves — so a blur before that has to
    // cancel the refresh, not just close a menu that is not open yet.
    let releaseFields!: (fields: Array<{ name: string; type: string }>) => void;
    backend.listMongoCompletionFields.mockReturnValue(new Promise((resolve) => (releaseFields = resolve)));
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{");
    expect(menuOpen()).toBe(false);

    filter!.dispatchEvent(new Event("blur", { bubbles: true }));
    await flushUi();
    releaseFields([{ name: "discountCode", type: "string" }]);
    await flushUi();

    expect(menuOpen()).toBe(false);
  });

  it("closes rather than splices a stale suggestion when the caret is clicked elsewhere", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{ createdAt: 1, _i");
    expect(menuOpen()).toBe(true);

    // Into the middle of `createdAt`, where the open suggestions mean nothing.
    await clickCaretTo(filter!, 3);
    expect(menuOpen()).toBe(false);

    pressKey(filter!, "Tab");
    await flushUi();
    expect(filter!.value).toBe("{ createdAt: 1, _i");
  });

  it("takes a suggestion clicked with the mouse", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{discountC");
    const option = document.body.querySelector<HTMLElement>('[role="option"]');

    // The press must not blur the input: blur dismisses, which would unmount
    // the option before its click could land.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option!.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushUi();

    expect(filter!.value).toBe("{discountCode: ");
  });

  it("keeps the list usable when its scrollbar is pressed", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{");
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    menu()!.dispatchEvent(mousedown);
    await flushUi();

    expect(mousedown.defaultPrevented).toBe(true);
    expect(menuOpen()).toBe(true);
  });

  it("closes when an arrow key moves the caret, and lets the key through", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{ createdA");
    expect(menuOpen()).toBe(true);

    const event = pressKey(filter!, "ArrowLeft");
    await flushUi();

    expect(menuOpen()).toBe(false);
    // The caret still has to move — only the menu was consumed.
    expect(event.defaultPrevented).toBe(false);
  });
});

/**
 * Typing straight into an empty bar, without opening the document first — the
 * way the issue's reporter did it, and the way anyone who has not noticed the
 * `{}` placeholder will.
 */
describe("DocumentBrowser MongoDB query bars opened by typing (issue #9427)", () => {
  it("opens the filter document around the first character and suggests from it", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "c");

    expect(filter!.value).toBe("{c}");
    // Between the braces, in key position — not after the `}` the rewrite added.
    expect(filter!.selectionStart).toBe(2);
    expect(menuOpen()).toBe(true);
    expect(menuOptions()).toEqual(expect.arrayContaining(["createdAt", "customerShippingAddress"]));
  });

  it("opens the sort document the same way", async () => {
    await mountBrowser();
    const [, sort] = queryInputs();

    await typeInto(sort!, "c");

    expect(sort!.value).toBe("{c}");
    expect(sort!.selectionStart).toBe(2);
    expect(menuOpen()).toBe(true);
    // The sort bar is a plain key map, so it offers no query operators.
    expect(menuOptions()).toEqual(expect.arrayContaining(["createdAt", "customerShippingAddress"]));
    expect(menuOptions().filter((option) => option.startsWith("$"))).toEqual([]);
  });

  it("completes a field typed without braces and leaves the caret in value position", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "d");
    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe("{discountCode: }");
    expect(filter!.selectionStart).toBe(15);
  });

  it("writes no braces of its own when the user opens the document", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{");

    expect(filter!.value).toBe("{");
  });

  it("leaves a pasted document alone", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, '{ createdAt: "2026-01-01" }');

    expect(filter!.value).toBe('{ createdAt: "2026-01-01" }');
  });

  it("leaves a backspace that happens to land on one character alone", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "ab", 2);
    // Deleting down to `a` leaves the same character and caret as typing it.
    await typeInto(filter!, "a", 1, "deleteContentBackward");

    expect(filter!.value).toBe("a");
  });

  it("leaves a character typed mid-text alone", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    // One character long, but the caret is before it: this is an edit, not a start.
    await typeInto(filter!, "c", 0);

    expect(filter!.value).toBe("c");
  });

  it("quotes a nested field path so the completed filter still parses", async () => {
    backend.documentFindDocuments.mockResolvedValue({
      documents: [{ _id: "1", customer: { name: "Ada", address: { city: "Beijing" } } }],
      raw_documents: [],
      total: 1,
      total_is_exact: true,
    });
    backend.listMongoCompletionFields.mockResolvedValue([]);
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "{customer.n}", 11);
    expect(menuOptions()).toEqual(["customer.name"]);

    pressKey(filter!, "Tab");
    await flushUi();

    // `{ customer.name: 1 }` is a document in neither the shell nor JSON.
    expect(filter!.value).toBe('{"customer.name": }');
    expect(() => JSON.parse(filter!.value.replace(": }", ": 1}"))).not.toThrow();
  });

  it("still leaves a plain identifier key unquoted", async () => {
    await mountBrowser();
    const [filter] = queryInputs();

    await typeInto(filter!, "d");
    pressKey(filter!, "Tab");
    await flushUi();

    expect(filter!.value).toBe("{discountCode: }");
  });

  it("does not open documents in the other stores' bars", async () => {
    await mountBrowser("elasticsearch");
    const [filter] = queryInputs();

    await typeInto(filter!, "c");

    expect(filter!.value).toBe("c");
    expect(menuOpen()).toBe(false);
  });
});
