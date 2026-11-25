// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-view-sort-test",
    name: "MySQL",
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  getMysqlTableAutoIncrement: vi.fn(),
  executeBatch: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  const Scroller = defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup:
      (props, { slots }) =>
      () =>
        h("div", [slots.before?.(), ...props.items.map((item, index) => slots.default?.({ item, index, active: true })), slots.after?.()]),
  });
  return {
    RecycleScroller: Scroller,
    DynamicScroller: Scroller,
    DynamicScrollerItem: defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  };
});

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("span") });
  return {
    AlertTriangle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    ClipboardList: Icon,
    Copy: Icon,
    Database: Icon,
    Info: Icon,
    Keyboard: Icon,
    KeyRound: Icon,
    ListChevronsUpDown: Icon,
    Loader2: Icon,
    Maximize2: Icon,
    Pencil: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    Rows3: Icon,
    Save: Icon,
    Search: Icon,
    Settings: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
    UserRound: Icon,
    X: Icon,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      name: "Button",
      inheritAttrs: false,
      setup:
        (_p, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      name: "Input",
      inheritAttrs: false,
      props: { modelValue: { type: [String, Number], default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
    }),
  };
});
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      inheritAttrs: false,
      setup:
        (_p, { attrs, slots }) =>
        () =>
          h("span", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Tabs: Div, TabsContent: Div, TabsList: Div, TabsTrigger: Div };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Div, DropdownMenuTrigger: Div };
});
vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Popover: Div, PopoverContent: Div, PopoverTrigger: Div };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Tooltip: Div, TooltipContent: Div, TooltipTrigger: Div };
});
vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" }, options: { type: Array, default: () => [] } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("button", { ...attrs, "data-searchable-select": "true", "data-model-value": props.modelValue }, String(props.modelValue)),
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});

vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.copyToClipboard,
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], generateSqlQuoteIdentifiers: true },
    updateEditorSettings: mocks.updateEditorSettings,
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: mocks.loadObjectDdl, invalidateObjectDdl: mocks.invalidateObjectDdl }));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  getMysqlTableAutoIncrement: mocks.getMysqlTableAutoIncrement,
  executeBatch: mocks.executeBatch,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];
const TABLE_COLUMNS = ["col_zebra", "col_alpha", "col_mike"];

function draftWithColumns(names: string[]) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: names.map((name, index) => ({
      id: `existing:${name}`,
      name,
      dataType: "int",
      isNullable: true,
      defaultValue: "",
      comment: "",
      isPrimaryKey: index === 0,
      characterSet: "",
      collation: "",
      extra: {},
      original: { name, data_type: "int", is_nullable: true, column_default: null, is_primary_key: index === 0, extra: null, comment: null },
      originalPosition: index,
      markedForDrop: false,
    })),
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

async function mountEditor() {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id int)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockResolvedValue({ value: [], cacheStatus: "remote" });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "test",
    tableName: "users",
    draft: draftWithColumns(TABLE_COLUMNS),
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await vi.waitFor(() => expect(root.querySelector("[data-column-name-input]")).not.toBeNull(), { timeout: 3000 });
  return root;
}

function columnNamesInDom(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")).map((input) => input.value);
}

function ordinalsInDom(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-column-row-index]")).map((row) => row.dataset.columnRowIndex ?? "");
}

function ordinalLabelsInDom(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-column-row-index] .tabular-nums")).map((span) => span.textContent?.trim() ?? "");
}

function sortButton(root: HTMLElement, key: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`[data-column-sort-key="${key}"]`);
  if (!button) throw new Error(`Missing sort button for ${key}`);
  return button;
}

function headerCell(root: HTMLElement, key: string): HTMLTableCellElement {
  const button = sortButton(root, key);
  const th = button.closest("th");
  if (!th) throw new Error(`Missing header cell for ${key}`);
  return th;
}

async function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.copyToClipboard.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor column view sort", () => {
  it("cycles none -> ascending -> descending -> none and reorders only the display", async () => {
    const root = await mountEditor();
    const nameButton = sortButton(root, "name");
    const th = headerCell(root, "name");

    expect(columnNamesInDom(root)).toEqual(["col_zebra", "col_alpha", "col_mike"]);
    expect(th.hasAttribute("aria-sort")).toBe(false);
    expect(nameButton.dataset.sortIndicator).toBe("↕");

    await click(nameButton);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    expect(nameButton.dataset.sortIndicator).toBe("▲");
    expect(columnNamesInDom(root)).toEqual(["col_alpha", "col_mike", "col_zebra"]);

    await click(nameButton);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    expect(nameButton.dataset.sortIndicator).toBe("▼");
    expect(columnNamesInDom(root)).toEqual(["col_zebra", "col_mike", "col_alpha"]);

    await click(nameButton);
    expect(th.hasAttribute("aria-sort")).toBe(false);
    expect(columnNamesInDom(root)).toEqual(["col_zebra", "col_alpha", "col_mike"]);
  });

  it("keeps the # ordinal tied to table order (jump sequence) while sorted (Q6)", async () => {
    const root = await mountEditor();
    await click(sortButton(root, "name"));

    // col_alpha(1), col_mike(2), col_zebra(0) in display order.
    expect(ordinalsInDom(root)).toEqual(["1", "2", "0"]);
    expect(ordinalLabelsInDom(root)).toEqual(["2", "3", "1"]);
  });

  it("leaves columns.value in table order: copy output is not sorted (Q6/Q9)", async () => {
    const root = await mountEditor();
    await click(sortButton(root, "name"));

    // Select the name column via the header body (not the sort button), then Ctrl+C.
    await click(headerCell(root, "name"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    await nextTick();

    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = String(mocks.copyToClipboard.mock.calls[0][0]);
    expect(copied.indexOf("col_zebra")).toBeLessThan(copied.indexOf("col_alpha"));
    expect(copied.indexOf("col_alpha")).toBeLessThan(copied.indexOf("col_mike"));
  });

  it("preserves column selection/copy and does not select when clicking the sort icon (Q5/Q11)", async () => {
    const root = await mountEditor();
    const th = headerCell(root, "name");

    // The sort button uses @click.stop, so it must not select the column.
    await click(sortButton(root, "name"));
    expect(th.dataset.columnSelected).not.toBe("true");

    // Clicking the header body still selects the whole column.
    await click(th);
    expect(th.dataset.columnSelected).toBe("true");
  });

  it("disables row drag while sorting is active and re-enables it after clearing (Q7)", async () => {
    const root = await mountEditor();
    const dragButtons = () => Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-label="structureEditor.dragColumn"]'));
    expect(dragButtons().length).toBeGreaterThan(0);
    expect(dragButtons().every((button) => !button.disabled)).toBe(true);

    await click(sortButton(root, "name"));
    expect(dragButtons().every((button) => button.disabled)).toBe(true);

    await click(root.querySelector<HTMLButtonElement>("[data-column-sort-clear]")!);
    expect(th_ariaSort(root, "name")).toBeNull();
    expect(dragButtons().every((button) => button.disabled)).toBe(false);
  });

  it("clears the sort on insert so the new column is visible in table order (Q7)", async () => {
    const root = await mountEditor();
    await click(sortButton(root, "name"));
    expect(th_ariaSort(root, "name")).toBe("ascending");

    const addButton = root.querySelector<HTMLButtonElement>('button[aria-label="structureEditor.addColumn"]');
    expect(addButton).not.toBeNull();
    await click(addButton!);

    expect(th_ariaSort(root, "name")).toBeNull();
    expect(columnNamesInDom(root)).toEqual(["col_zebra", "col_alpha", "col_mike", ""]);
  });

  it("jumps search matches in display order, not table order (Q10)", async () => {
    const root = await mountEditor();
    await click(sortButton(root, "name"));

    const searchInput = root.querySelector<HTMLInputElement>('input[placeholder="structureEditor.searchColumns"]');
    expect(searchInput).not.toBeNull();
    searchInput!.value = "col";
    searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const highlightedId = () => root.querySelector<HTMLElement>(".structure-column-search-current")?.closest("tr")?.dataset.columnId;
    searchInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(highlightedId()).toBe("existing:col_alpha");

    searchInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(highlightedId()).toBe("existing:col_mike");
  });

  it("clicking the # header clears the sort and restores table order (Q6)", async () => {
    const root = await mountEditor();
    await click(sortButton(root, "name"));
    expect(columnNamesInDom(root)).toEqual(["col_alpha", "col_mike", "col_zebra"]);

    await click(root.querySelector<HTMLButtonElement>("[data-column-sort-clear]")!);
    expect(columnNamesInDom(root)).toEqual(["col_zebra", "col_alpha", "col_mike"]);
    expect(ordinalsInDom(root)).toEqual(["0", "1", "2"]);
  });
});

function th_ariaSort(root: HTMLElement, key: string): string | null {
  return headerCell(root, key).getAttribute("aria-sort");
}
