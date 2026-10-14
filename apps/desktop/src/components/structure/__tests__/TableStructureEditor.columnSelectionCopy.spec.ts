// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-column-copy-test",
    name: "MySQL",
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
  },
  copyToClipboard: vi.fn(),
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
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

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
        (_props, { attrs, slots }) =>
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
          h("input", {
            ...attrs,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          }),
    }),
  };
});
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      name: "Badge",
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
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
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const Button = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  });
  return { Tabs: Div, TabsContent: Div, TabsList: Div, TabsTrigger: Button };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const Button = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Button, DropdownMenuTrigger: Div };
});
vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
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
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Tooltip: Div, TooltipContent: Div, TooltipTrigger: Div };
});
vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      name: "SearchableSelect",
      inheritAttrs: false,
      props: {
        modelValue: { type: String, default: "" },
        options: { type: Array, default: () => [] },
        allowCustom: { type: Boolean, default: false },
      },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("button", {
            ...attrs,
            type: "button",
            "data-searchable-select": "true",
            "data-model-value": props.modelValue,
            "data-options": JSON.stringify(props.options),
            "data-allow-custom": String(props.allowCustom),
          }),
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
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
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
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
// Keep the real shortcut guards (native-clipboard detection) and only stub the
// write side, so tests observe exactly what the editor would copy.
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  copyToClipboard: mocks.copyToClipboard,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

type SeedColumn = {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey?: boolean;
  comment?: string;
  markedForDrop?: boolean;
};

function draftWithColumns(seed: SeedColumn[]) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: seed.map((column, index) => ({
      id: `existing:${column.name}`,
      name: column.name,
      dataType: column.dataType,
      isNullable: column.isNullable,
      defaultValue: "",
      comment: column.comment ?? "",
      isPrimaryKey: column.isPrimaryKey ?? false,
      characterSet: "",
      collation: "",
      extra: {},
      original: {
        name: column.name,
        data_type: column.dataType,
        is_nullable: column.isNullable,
        column_default: null,
        is_primary_key: column.isPrimaryKey ?? false,
        extra: null,
        comment: null,
      },
      originalPosition: index,
      markedForDrop: column.markedForDrop ?? false,
    })),
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

/** id/name stay, "legacy" is drop-marked so copy output must exclude it. */
function defaultSeed(): SeedColumn[] {
  return [
    { name: "id", dataType: "int", isNullable: false, isPrimaryKey: true },
    { name: "name", dataType: "varchar(64)", isNullable: true, comment: "user name" },
    { name: "legacy", dataType: "int", isNullable: true, markedForDrop: true },
  ];
}

async function mountEditor(draft: ReturnType<typeof draftWithColumns>) {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.copyToClipboard.mockResolvedValue(undefined);

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "test",
    tableName: "user",
    draft,
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await vi.waitFor(() => expect(root.querySelector("[data-column-name-input]")).not.toBeNull(), { timeout: 3000 });
  return root;
}

/** Header cells of the editable columns grid (its header table is separate from the per-row body tables). */
function headerCells(root: HTMLElement): HTMLTableCellElement[] {
  return [...root.querySelectorAll<HTMLTableCellElement>(".structure-column-virtual-header-table thead th")];
}

function headerCell(root: HTMLElement, label: string): HTMLTableCellElement {
  // The actions header renders buttons around its label, so match by inclusion.
  const cell = headerCells(root).find((th) => (th.textContent ?? "").includes(label));
  expect(cell, `missing header cell ${label}`).toBeDefined();
  return cell!;
}

function clickHeader(root: HTMLElement, label: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}) {
  headerCell(root, label).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift }));
}

/** Header labels (i18n keys) currently flagged data-column-selected="true". */
function selectedHeaderLabels(root: HTMLElement): string[] {
  return headerCells(root)
    .filter((th) => th.dataset.columnSelected === "true")
    .map((th) => th.textContent?.trim() ?? "");
}

function columnNameCells(root: HTMLElement): HTMLTableCellElement[] {
  return [...root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")].map((input) => input.closest("td") as HTMLTableCellElement);
}

function dispatchShortcut(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.db_type = "mysql";
  mocks.connection.driver_profile = "mysql";
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE user (id int)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockResolvedValue({ value: [], cacheStatus: "remote" });
  mocks.getMysqlTableAutoIncrement.mockResolvedValue(null);
  mocks.buildMysqlAutoIncrementSql.mockResolvedValue("");
  mocks.executeBatch.mockResolvedValue({ affected_rows: 0 });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor header column selection", () => {
  it("selects a single column on header click and highlights its cells", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    clickHeader(root, "structureEditor.columnName");
    await nextTick();

    expect(selectedHeaderLabels(root)).toEqual(["structureEditor.columnName"]);
    // The actions header never participates in column selection.
    expect(headerCell(root, "structureEditor.actions").dataset.columnSelected).toBeUndefined();
    for (const cell of columnNameCells(root)) expect(cell.classList.contains("structure-grid-column-selected")).toBe(true);
  });

  it("toggles columns with ctrl-click", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    clickHeader(root, "structureEditor.columnName");
    clickHeader(root, "structureEditor.dataType", { ctrl: true });
    await nextTick();
    expect(selectedHeaderLabels(root)).toEqual(["structureEditor.columnName", "structureEditor.dataType"]);

    clickHeader(root, "structureEditor.dataType", { ctrl: true });
    await nextTick();
    expect(selectedHeaderLabels(root)).toEqual(["structureEditor.columnName"]);
  });

  it("selects the range between anchor and target on shift-click", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    clickHeader(root, "structureEditor.columnName");
    clickHeader(root, "structureEditor.comment", { shift: true });
    await nextTick();

    expect(selectedHeaderLabels(root)).toEqual(["structureEditor.columnName", "structureEditor.dataType", "structureEditor.length", "structureEditor.nullable", "structureEditor.primaryKey", "structureEditor.defaultValue", "structureEditor.comment"]);
  });

  it("clears the header selection when a field row is clicked", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    clickHeader(root, "structureEditor.columnName");
    await nextTick();
    expect(selectedHeaderLabels(root)).toEqual(["structureEditor.columnName"]);

    // Click an ordinary field row (drop-marked rows are not selectable).
    const row = root.querySelector<HTMLElement>('tr[data-column-id="existing:id"]')!;
    expect(row).not.toBeNull();
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(selectedHeaderLabels(root)).toEqual([]);
    for (const cell of columnNameCells(root)) expect(cell.classList.contains("structure-grid-column-selected")).toBe(false);
  });
});

describe("TableStructureEditor column selection copy shortcuts", () => {
  it("selects every copyable column on Cmd+A outside editable targets", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    const event = dispatchShortcut(document.body, "a");
    expect(event.defaultPrevented).toBe(true);
    await nextTick();

    const selected = selectedHeaderLabels(root);
    const expected = headerCells(root)
      .map((th) => th.textContent?.trim() ?? "")
      .filter((label) => !label.includes("structureEditor.actions"));
    expect(selected).toEqual(expected);
  });

  it("copies the selected columns as TSV on Cmd+C and excludes drop-marked rows", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    clickHeader(root, "structureEditor.columnName");
    clickHeader(root, "structureEditor.dataType", { ctrl: true });
    clickHeader(root, "structureEditor.nullable", { ctrl: true });
    await nextTick();

    const event = dispatchShortcut(document.body, "c");
    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Labels and yes/no literals come back as raw i18n keys because the test
    // i18n mock is the identity; the base type of `varchar(64)` is `varchar`.
    expect(mocks.copyToClipboard).toHaveBeenCalledWith("structureEditor.columnName\tstructureEditor.dataType\tstructureEditor.nullable\nid\tint\tstructureEditor.no\nname\tvarchar\tstructureEditor.yes");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("grid.copied"), { timeout: 3000 });
  });

  it("leaves Cmd+A/Cmd+C to the browser when an input is focused", async () => {
    const root = await mountEditor(draftWithColumns(defaultSeed()));

    const input = root.querySelector<HTMLInputElement>("[data-column-name-input]")!;
    const selectAll = dispatchShortcut(input, "a");
    const copy = dispatchShortcut(input, "c");

    expect(selectAll.defaultPrevented).toBe(false);
    expect(copy.defaultPrevented).toBe(false);
    expect(selectedHeaderLabels(root)).toEqual([]);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
  });

  it("does not intercept Cmd+C when no column is selected", async () => {
    await mountEditor(draftWithColumns(defaultSeed()));

    const event = dispatchShortcut(document.body, "c");

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
  });
});
