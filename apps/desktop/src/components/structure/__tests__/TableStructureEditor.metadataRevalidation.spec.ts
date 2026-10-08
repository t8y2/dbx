// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #8816: the editor serves its initial load from the frontend
// metadata cache, which in-app mutations only invalidate. A table rebuilt by
// another session therefore reopened with stale columns; cache-served loads
// must revalidate the affected facets in the background without clobbering
// pending user edits.

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-revalidation",
    name: "MySQL",
    db_type: "mysql",
    driver_label: "MySQL",
    driver_profile: "",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
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
    ChevronLeft: Icon,
    ChevronRight: Icon,
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
    RotateCcw: Icon,
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
  const TabsContent = defineComponent({
    name: "MockTabsContent",
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h("button", { ...attrs, type: "button", "data-tab-trigger": props.value }, slots.default?.()),
  });
  return { Tabs: Div, TabsContent, TabsList: Div, TabsTrigger };
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
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Div, DropdownMenuTrigger: Div };
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
      props: { modelValue: { type: String, default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("button", { ...attrs, type: "button", "data-model-value": props.modelValue }),
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
  const Select = defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    setup:
      (props, { attrs, slots, emit }) =>
      () =>
        h("div", attrs, [
          h(
            "select",
            { value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) },
            ["BTREE", "FULLTEXT", "SPATIAL"].map((value) => h("option", { value }, value)),
          ),
          slots.default?.(),
        ]),
  });
  return { Select, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});
vi.mock("@/components/editor/EditorSearchPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "MockEditorSearchPanel",
      setup: () => ({ openSearch: () => false, closeSearch: () => false }),
      render: () => h("div", { "data-editor-search-panel": "true" }),
    }),
  };
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
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], fontSize: 13, fontFamily: "monospace", theme: "default", generateSqlQuoteIdentifiers: true },
    updateEditorSettings: mocks.updateEditorSettings,
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/sql/sqlFormatter", () => ({
  formatSqlForDisplay: vi.fn(async (sql: string) => sql),
  sqlFormatDialectForDbType: vi.fn(() => "mysql"),
}));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: vi.fn(async () => []), editorFontTheme: vi.fn(() => []) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeBatch: mocks.executeBatch,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";
import { createColumnDrafts, createIndexDrafts } from "@/lib/table/tableStructureEditorState";
import type { TableStructureEditorDraft } from "@/types/database";
import type { BuildTableStructureChangeSqlOptions, EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";

const mountedApps: App[] = [];

const initialColumns = [{ name: "id", data_type: "bigint", nullable: false, default_value: null, comment: "" }];
const rebuiltColumns = [
  { name: "id", data_type: "integer", nullable: false, default_value: null, comment: "" },
  { name: "email", data_type: "varchar(255)", nullable: true, default_value: null, comment: "" },
];

function columnsFacetCalls() {
  return mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "columns");
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountStructureEditor(draft?: TableStructureEditorDraft, tableName = "users") {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    tableName,
    draft,
  });
  mountedApps.push(app);
  app.mount(root);
  await vi.waitFor(
    () => {
      expect(root.textContent).toContain("structureEditor.noChanges");
    },
    { timeout: 3000 },
  );
  await settle();
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.db_type = "mysql";
  mocks.connection.driver_profile = "";
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false, isForeign: false });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
});

describe("TableStructureEditor column index actions", () => {
  const fields = [
    { name: "id", data_type: "bigint", nullable: false, default_value: null, comment: "" },
    { name: "email", data_type: "varchar(255)", nullable: true, default_value: null, comment: "" },
    { name: "region", data_type: "varchar(32)", nullable: true, default_value: null, comment: "" },
    { name: "metadata", data_type: "json", nullable: true, default_value: null, comment: "" },
    { name: "location", data_type: "point", nullable: false, default_value: null, comment: "" },
    { name: "area", data_type: "polygon", nullable: true, default_value: null, comment: "" },
  ];

  const columnMetadata = fields.map(({ nullable, default_value, ...column }) => ({ ...column, is_nullable: nullable, column_default: default_value, is_primary_key: false }));

  function loadMetadata(indexes: unknown[] = []) {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet) => ({ value: facet === "columns" ? columnMetadata : facet === "indexes" ? indexes : facet === "comment" ? "" : [], cacheStatus: "remote" }));
  }

  function savedIndexDraft(index: EditableStructureIndex): TableStructureEditorDraft {
    return {
      initialized: true,
      dirty: true,
      activeTab: "indexes",
      newTableName: "",
      tableComment: "",
      originalTableComment: "",
      columns: createColumnDrafts(columnMetadata, "mysql"),
      indexes: [index],
      foreignKeys: [],
      triggers: [],
      loadedMetadataFacets: ["columns", "indexes", "comment"],
    };
  }

  function fieldRow(root: HTMLElement, name: string): HTMLElement {
    const input = [...root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")].find((item) => item.value === name);
    if (!input) throw new Error(`Missing field ${name}`);
    return input.closest<HTMLElement>("tr")!;
  }

  function menuButton(label: string): HTMLButtonElement {
    const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing menu item ${label}`);
    return button;
  }

  async function openSubmenu(row: HTMLElement, label: string) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    await settle();
    menuButton(label).dispatchEvent(new MouseEvent("mouseenter"));
    await settle();
  }

  function latestDraft(): BuildTableStructureChangeSqlOptions {
    return mocks.buildTableStructureChangeSql.mock.calls.at(-1)?.[0];
  }

  function indexRow(root: HTMLElement, position = 0): HTMLElement {
    return root.querySelector<HTMLElement>(`[data-index-row-index="${position}"]`)!;
  }

  async function expectIndexName(root: HTMLElement, name: string) {
    await vi.waitFor(() => expect(indexRow(root).querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe(name));
  }

  it("loads index membership on the fields tab and creates a unique index as a draft", async () => {
    loadMetadata([{ name: "idx_email", columns: ["email"], is_unique: false, is_primary: false }]);
    const root = await mountStructureEditor();
    expect(fieldRow(root, "email").classList.contains("structure-column-index-key")).toBe(true);
    expect(mocks.loadObjectMetadataFacet.mock.calls.some((call) => call[1] === "indexes")).toBe(true);

    await openSubmenu(fieldRow(root, "region"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createUniqueIndex").click();
    await vi.waitFor(() => expect(latestDraft().indexes).toEqual(expect.arrayContaining([expect.objectContaining({ columns: ["region"], isUnique: true, isPrimary: false })])));
    expect(fieldRow(root, "region").classList.contains("structure-column-unique-key")).toBe(true);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("builds a composite index in selection order and appends fields without duplicates", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    fieldRow(root, "email").click();
    fieldRow(root, "region").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await openSubmenu(fieldRow(root, "region"), "structureEditor.createCompositeIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await vi.waitFor(() => expect(latestDraft().indexes[0]?.columns).toEqual(["email", "region"]));
    expect(fieldRow(root, "email").classList.contains("structure-column-index-key")).toBe(true);
    expect(fieldRow(root, "region").classList.contains("structure-column-index-key")).toBe(true);

    await openSubmenu(fieldRow(root, "id"), "structureEditor.addColumnsToIndex");
    menuButton(`${latestDraft().indexes[0].name} (email, region)`).click();
    await vi.waitFor(() => expect(latestDraft().indexes[0]?.columns).toEqual(["email", "region", "id"]));
    expect(latestDraft().indexes[0]?.columnOpclasses).toEqual([null, null, null]);

    await openSubmenu(fieldRow(root, "id"), "structureEditor.addColumnsToIndex");
    expect(menuButton(`${latestDraft().indexes[0].name} (email, region, id)`).disabled).toBe(true);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("creates one composite primary key and makes its members non-nullable", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    fieldRow(root, "id").click();
    fieldRow(root, "email").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createCompositeIndex");
    menuButton("structureEditor.createPrimaryIndex").click();
    await vi.waitFor(() =>
      expect(
        latestDraft()
          .columns.filter((column) => column.isPrimaryKey)
          .map((column) => [column.name, column.isNullable]),
      ).toEqual([
        ["id", false],
        ["email", false],
      ]),
    );
    expect(latestDraft().indexes).toEqual([]);
    await openSubmenu(fieldRow(root, "region"), "structureEditor.createColumnIndex");
    expect(menuButton("structureEditor.createPrimaryIndex").disabled).toBe(true);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("colors every member of a composite unique index and ignores dropped indexes", async () => {
    loadMetadata([{ name: "uniq_email_region", columns: ["email", "region"], is_unique: true, is_primary: false }]);
    const root = await mountStructureEditor();
    expect(fieldRow(root, "email").classList.contains("structure-column-unique-key")).toBe(true);
    expect(fieldRow(root, "region").classList.contains("structure-column-unique-key")).toBe(true);
    expect(fieldRow(root, "id").classList.contains("structure-column-unique-key")).toBe(false);
    const drop = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "structureEditor.drop" && button.closest("tr")?.querySelector("[data-index-name-input]"));
    expect(drop).toBeDefined();
    drop!.click();
    await settle();
    expect(fieldRow(root, "email").classList.contains("structure-column-unique-key")).toBe(false);
    expect(fieldRow(root, "region").classList.contains("structure-column-unique-key")).toBe(false);
  });

  it("keeps names stable for field changes and updates only the automatic type prefix", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await expectIndexName(root, "idx_email");
    indexRow(root).querySelector<HTMLElement>('[data-index-column="region"]')!.click();
    await expectIndexName(root, "idx_email");
    const unique = indexRow(root).querySelector<HTMLInputElement>("[data-index-unique]")!;
    unique.checked = true;
    unique.dispatchEvent(new Event("change"));
    await expectIndexName(root, "uk_email");
    const type = indexRow(root).querySelector<HTMLSelectElement>("[data-index-type] select")!;
    type.value = "FULLTEXT";
    type.dispatchEvent(new Event("change"));
    await expectIndexName(root, "ft_email");
    expect(unique.disabled).toBe(true);
    expect(indexRow(root).classList.contains("structure-index-fulltext-key")).toBe(true);
    expect(fieldRow(root, "email").classList.contains("structure-column-fulltext-key")).toBe(true);
    const name = indexRow(root).querySelector<HTMLInputElement>("[data-index-name-input]")!;
    name.value = "custom_search";
    name.dispatchEvent(new Event("input"));
    indexRow(root).querySelector<HTMLElement>('[data-index-column="region"]')!.click();
    await expectIndexName(root, "custom_search");
    indexRow(root).querySelector<HTMLButtonElement>("[data-regenerate-index-name]")!.click();
    await expectIndexName(root, "ft_email");
    type.value = "BTREE";
    type.dispatchEvent(new Event("change"));
    await expectIndexName(root, "idx_email");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("keeps existing names stable unless regeneration is explicitly requested", async () => {
    loadMetadata([{ name: "legacy_email", columns: ["email"], is_unique: true, is_primary: false }]);
    const root = await mountStructureEditor();
    indexRow(root).querySelector<HTMLElement>('[data-index-column="region"]')!.click();
    await expectIndexName(root, "legacy_email");
    indexRow(root).querySelector<HTMLButtonElement>("[data-regenerate-index-name]")!.click();
    await expectIndexName(root, "uk_email");
    indexRow(root).querySelector<HTMLElement>('[data-index-column="region"]')!.click();
    await expectIndexName(root, "uk_email");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("remembers the first selected field even after removing every original member", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await expectIndexName(root, "idx_email");
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="region"]')!.click();
    await settle();
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="email"]')!.click();
    await expectIndexName(root, "idx_email");
    const unique = indexRow(root).querySelector<HTMLInputElement>("[data-index-unique]")!;
    unique.checked = true;
    unique.dispatchEvent(new Event("change"));
    await expectIndexName(root, "uk_email");
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="region"]')!.click();
    await settle();
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="location"]')!.click();
    await expectIndexName(root, "uk_email");
    await vi.waitFor(() => expect(latestDraft().indexes[0]).toMatchObject({ columns: ["location"], autoNameColumn: "email" }));
    indexRow(root).querySelector<HTMLButtonElement>("[data-regenerate-index-name]")!.click();
    await expectIndexName(root, "uk_location");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])("preserves a legacy saved name without a naming seed (nameEdited=%s)", async (nameEdited) => {
    loadMetadata();
    const [index] = createIndexDrafts([{ name: "USERS_EMAIL_REGION_IDX", columns: ["email", "region"], is_unique: false, is_primary: false }]);
    delete index.original;
    index.nameEdited = nameEdited;
    const draft = savedIndexDraft(index);
    const snapshot = JSON.stringify(draft);
    const root = await mountStructureEditor(draft);
    await expectIndexName(root, "USERS_EMAIL_REGION_IDX");
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="email"]')!.click();
    const unique = indexRow(root).querySelector<HTMLInputElement>("[data-index-unique]")!;
    unique.checked = true;
    unique.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(latestDraft().indexes[0]).toMatchObject({ name: "USERS_EMAIL_REGION_IDX", columns: ["region"], isUnique: true }));
    expect(JSON.stringify(draft)).toBe(snapshot);
    indexRow(root).querySelector<HTMLButtonElement>("[data-regenerate-index-name]")!.click();
    await expectIndexName(root, "uk_region");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("restores the new naming seed even when its original field is no longer selected", async () => {
    loadMetadata();
    const [index] = createIndexDrafts([{ name: "idx_email", columns: ["region"], is_unique: false, is_primary: false }]);
    delete index.original;
    index.nameEdited = false;
    index.autoNameColumn = "email";
    const root = await mountStructureEditor(savedIndexDraft(index));
    const unique = indexRow(root).querySelector<HTMLInputElement>("[data-index-unique]")!;
    unique.checked = true;
    unique.dispatchEvent(new Event("change"));
    await expectIndexName(root, "uk_email");
    await vi.waitFor(() => expect(latestDraft().indexes[0]).toMatchObject({ columns: ["region"], autoNameColumn: "email" }));
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("supports legacy blank drafts without overwriting a manually cleared name (nameEdited=%s)", async (nameEdited) => {
    loadMetadata();
    const [index] = createIndexDrafts([{ name: "", columns: [], is_unique: false, is_primary: false }]);
    delete index.original;
    index.nameEdited = nameEdited;
    const root = await mountStructureEditor(savedIndexDraft(index));
    indexRow(root).querySelector<HTMLInputElement>('[data-index-column="email"]')!.click();
    await expectIndexName(root, nameEdited ? "" : "idx_email");
    await vi.waitFor(() => expect(latestDraft().indexes[0].columns).toEqual(["email"]));
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([undefined, ["columns", "comment"]] as const)("preserves saved index edits with incomplete legacy facet flags (%s)", async (facets) => {
    loadMetadata([{ name: "server_index", columns: ["id"], is_unique: false, is_primary: false }]);
    const [index] = createIndexDrafts([{ name: "pending_email", columns: ["email", "region"], is_unique: true, is_primary: false }]);
    delete index.original;
    const draft = savedIndexDraft(index);
    draft.activeTab = "columns";
    draft.loadedMetadataFacets = facets ? [...facets] : undefined;
    const root = await mountStructureEditor(draft);
    await expectIndexName(root, "pending_email");
    await vi.waitFor(() => expect(latestDraft().indexes).toEqual([expect.objectContaining({ name: "pending_email", columns: ["email", "region"], isUnique: true })]));
    expect(mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "indexes")).toHaveLength(0);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each(["postgres", "sqlite", "oracle", "sqlserver"])("retains table-qualified automatic names on %s", async (databaseType) => {
    mocks.connection.db_type = databaseType;
    loadMetadata();
    for (const table of ["users", "orders"]) {
      const root = await mountStructureEditor(undefined, table);
      await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
      menuButton("structureEditor.createNormalIndex").click();
      await expectIndexName(root, `${table.toUpperCase()}_EMAIL_IDX`);
      indexRow(root).querySelector<HTMLInputElement>('[data-index-column="region"]')!.click();
      await expectIndexName(root, `${table.toUpperCase()}_EMAIL_IDX`);
    }
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["Doris", "doris", "doris"],
    ["Doris MySQL profile", "mysql", "doris"],
    ["StarRocks", "starrocks", "starrocks"],
    ["StarRocks MySQL profile", "mysql", "starrocks"],
    ["GoldenDB", "goldendb", "goldendb"],
    ["SunDB", "sundb", "sundb"],
    ["Databend", "databend", "databend"],
  ] as const)("retains table-qualified automatic names on %s", async (_label, databaseType, driverProfile) => {
    mocks.connection.db_type = databaseType;
    mocks.connection.driver_profile = driverProfile;
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await expectIndexName(root, "USERS_EMAIL_IDX");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("preserves lowercase table-qualified naming for GaussDB M-mode", async () => {
    mocks.connection.db_type = "gaussdb";
    mocks.connection.driver_profile = "gaussdb-m";
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await expectIndexName(root, "users_email_idx");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("keeps untouched historical special indexes out of validation for unrelated edits", async () => {
    // Drivers may expose aliases that the newer frontend type whitelist does not recognize.
    const columnsWithAlias = columnMetadata.map((column) => (column.name === "email" ? { ...column, data_type: "character varying(255)" } : column));
    const indexes = [{ name: "legacy_search", columns: ["email"], is_unique: false, is_primary: false, index_type: "FULLTEXT" }];
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet) => ({ value: facet === "columns" ? columnsWithAlias : facet === "indexes" ? indexes : facet === "comment" ? "" : [], cacheStatus: "remote" }));
    const root = await mountStructureEditor();
    expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();
    const name = fieldRow(root, "region").querySelector<HTMLInputElement>("[data-column-name-input]")!;
    name.value = "region_code";
    name.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(latestDraft().columns.some((column) => column.name === "region_code")).toBe(true));
    expect(latestDraft().indexes[0]).toMatchObject({ name: "legacy_search", columns: ["email"], original: indexes[0] });
    expect(root.textContent).not.toContain("structureEditor.fulltextIndexColumns");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("still validates a changed field used by an existing spatial index", async () => {
    loadMetadata([{ name: "legacy_location", columns: ["location"], is_unique: false, is_primary: false, index_type: "SPATIAL" }]);
    const root = await mountStructureEditor();
    const nullable = fieldRow(root, "location").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0];
    nullable.checked = true;
    nullable.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.spatialIndexNullable"));
    expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("shows selected checkboxes in index order and preserves selection when searching by name or type", async () => {
    loadMetadata([{ name: "uk_region_email", columns: ["region", "email"], is_unique: true, is_primary: false }]);
    const root = await mountStructureEditor();
    const picker = indexRow(root).querySelector<HTMLElement>("[data-index-column-picker]")!;
    const inputs = () => [...picker.querySelectorAll<HTMLInputElement>("[data-index-column]")];
    expect(
      inputs()
        .slice(0, 2)
        .map((input) => [input.dataset.indexColumn, input.checked]),
    ).toEqual([
      ["region", true],
      ["email", true],
    ]);
    const search = picker.querySelector<HTMLInputElement>("[data-index-column-search]")!;
    search.value = "varchar";
    search.dispatchEvent(new Event("input"));
    await settle();
    expect(inputs().map((input) => input.dataset.indexColumn)).toEqual(["region", "email"]);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(inputs()[0]);
    inputs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(inputs()[1]);
    search.value = "missing_field";
    search.dispatchEvent(new Event("input"));
    await settle();
    expect(picker.textContent).toContain("structureEditor.noMatchingIndexColumns");
    search.value = "";
    search.dispatchEvent(new Event("input"));
    await settle();
    expect(
      inputs()
        .filter((input) => input.checked)
        .map((input) => input.dataset.indexColumn),
    ).toEqual(["region", "email"]);
    inputs()[0].click();
    await settle();
    expect(
      inputs()
        .filter((input) => input.checked)
        .map((input) => input.dataset.indexColumn),
    ).toEqual(["email"]);
    await expectIndexName(root, "uk_region_email");
  });

  it("shows distinct indicators for multiple index kinds on the same field", async () => {
    loadMetadata([
      { name: "uk_email", columns: ["email"], is_unique: true, is_primary: false },
      { name: "idx_email_region", columns: ["email", "region"], is_unique: false, is_primary: false },
      { name: "ft_email", columns: ["email"], is_unique: false, is_primary: false, index_type: "FULLTEXT" },
      { name: "sp_location", columns: ["location"], is_unique: false, is_primary: false, index_type: "SPATIAL" },
    ]);
    const root = await mountStructureEditor();
    expect([...fieldRow(root, "email").querySelectorAll<HTMLElement>("[data-index-kind]")].map((icon) => icon.dataset.indexKind)).toEqual(["unique", "index", "fulltext"]);
    expect(fieldRow(root, "email").classList.contains("structure-column-unique-key")).toBe(true);
    expect(fieldRow(root, "location").classList.contains("structure-column-spatial-key")).toBe(true);
    expect(indexRow(root, 3).classList.contains("structure-index-spatial-key")).toBe(true);
  });

  it("disables incompatible special indexes and adding another column to a spatial index", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "metadata"), "structureEditor.createColumnIndex");
    expect(menuButton("structureEditor.createFulltextIndex").disabled).toBe(true);
    expect(menuButton("structureEditor.createSpatialIndex").disabled).toBe(true);
    await openSubmenu(fieldRow(root, "area"), "structureEditor.createColumnIndex");
    expect(menuButton("structureEditor.createSpatialIndex").disabled).toBe(true);
    await openSubmenu(fieldRow(root, "location"), "structureEditor.createColumnIndex");
    expect(menuButton("structureEditor.createSpatialIndex").disabled).toBe(false);
    menuButton("structureEditor.createSpatialIndex").click();
    await expectIndexName(root, "sp_location");
    await openSubmenu(fieldRow(root, "email"), "structureEditor.addColumnsToIndex");
    expect(menuButton("sp_location (location)").disabled).toBe(true);
    // The action guard also protects against a stale/programmatically invoked menu item.
    indexRow(root).querySelector<HTMLElement>('[data-index-column="email"]')!.click();
    await vi.waitFor(() => expect(latestDraft().indexes[0]?.columns).toEqual(["location"]));
    const nullable = fieldRow(root, "location").querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0];
    nullable.checked = true;
    nullable.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.spatialIndexNullable"));
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("renders checkboxes without dynamic yes/no toggle text (#8148)", async () => {
    loadMetadata();
    const root = await mountStructureEditor();
    await openSubmenu(fieldRow(root, "email"), "structureEditor.createColumnIndex");
    menuButton("structureEditor.createNormalIndex").click();
    await expectIndexName(root, "idx_email");

    const unique = indexRow(root).querySelector<HTMLInputElement>("[data-index-unique]")!;
    const uniqueCell = unique.closest("td")!;
    expect(uniqueCell.textContent?.trim()).toBe("");

    unique.checked = true;
    unique.dispatchEvent(new Event("change"));
    await settle();
    expect(uniqueCell.textContent?.trim()).toBe("");

    const nullable = fieldRow(root, "location").querySelector<HTMLInputElement>('input[aria-label="structureEditor.nullable"]')!;
    const nullableCell = nullable.closest("td")!;
    expect(nullableCell.textContent?.trim()).toBe("");

    nullable.checked = true;
    nullable.dispatchEvent(new Event("change"));
    await settle();
    expect(nullableCell.textContent?.trim()).toBe("");
  });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor metadata revalidation (#8816)", () => {
  it("re-fetches cache-served columns in the background and applies changes on a clean draft", async () => {
    let columnsCalls = 0;
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => {
      if (facet === "columns") {
        columnsCalls += 1;
        return columnsCalls === 1 ? { value: initialColumns, cacheStatus: "memory" } : { value: rebuiltColumns, cacheStatus: "remote" };
      }
      if (facet === "comment") return { value: "", cacheStatus: "remote" };
      return { value: [], cacheStatus: "remote" };
    });

    const root = await mountStructureEditor();

    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    expect(columnsFacetCalls()[1][3]).toEqual({ force: true });
    expect(root.textContent).toContain("email");
    // The revalidation must not loop: applying happens outside loadStructure.
    await settle();
    expect(columnsFacetCalls().length).toBe(2);
  });

  it("does not re-fetch when the initial load came from the remote source", async () => {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => {
      if (facet === "columns") return { value: initialColumns, cacheStatus: "remote" };
      if (facet === "comment") return { value: "", cacheStatus: "remote" };
      return { value: [], cacheStatus: "remote" };
    });

    const root = await mountStructureEditor();
    await settle();

    expect(columnsFacetCalls().length).toBe(1);
    expect(root.textContent).not.toContain("email");
  });

  it("keeps pending user edits when the background revalidation brings different columns", async () => {
    let columnsCalls = 0;
    let resolveRevalidation: ((result: { value: unknown; cacheStatus: string }) => void) | undefined;
    mocks.loadObjectMetadataFacet.mockImplementation((_request: unknown, facet: string) => {
      if (facet === "columns") {
        columnsCalls += 1;
        if (columnsCalls === 1) return Promise.resolve({ value: initialColumns, cacheStatus: "memory" });
        return new Promise((resolve) => {
          resolveRevalidation = resolve;
        });
      }
      if (facet === "comment") return Promise.resolve({ value: "", cacheStatus: "remote" });
      return Promise.resolve({ value: [], cacheStatus: "remote" });
    });

    const root = await mountStructureEditor();

    // The background revalidation started and is held pending.
    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    expect(resolveRevalidation).toBeDefined();

    // The user starts editing while the revalidation is in flight.
    const nameInput = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    expect(nameInput).not.toBeNull();
    nameInput!.value = "renamed_id";
    nameInput!.dispatchEvent(new Event("input"));
    await settle();

    resolveRevalidation!({ value: rebuiltColumns, cacheStatus: "remote" });
    await settle();

    const renamedInput = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    expect(renamedInput?.value).toBe("renamed_id");
    expect(root.textContent).not.toContain("email");
  });

  it("applies fresh columns even when the comment revalidation fails", async () => {
    let columnsCalls = 0;
    mocks.loadObjectMetadataFacet.mockImplementation((_request: unknown, facet: string, _loader?: unknown, options?: { force?: boolean }) => {
      if (facet === "columns") {
        columnsCalls += 1;
        return Promise.resolve(columnsCalls === 1 ? { value: initialColumns, cacheStatus: "memory" } : { value: rebuiltColumns, cacheStatus: "remote" });
      }
      if (facet === "comment") {
        // Cache-served first so the file comment is part of the revalidation.
        if (options?.force) return Promise.reject(new Error("comment unavailable"));
        return Promise.resolve({ value: "", cacheStatus: "memory" });
      }
      return Promise.resolve({ value: [], cacheStatus: "remote" });
    });

    const root = await mountStructureEditor();

    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    await settle();
    expect(root.textContent).toContain("email");
  });
});

describe("restored structure snapshots after external DDL", () => {
  function restoredDraft(dirty: boolean | undefined): TableStructureEditorDraft {
    return {
      initialized: true,
      dirty,
      activeTab: "columns",
      newTableName: "",
      tableComment: "",
      originalTableComment: "",
      columns: createColumnDrafts(
        initialColumns.map((column) => ({ name: column.name, data_type: column.data_type, is_nullable: column.nullable, column_default: column.default_value, is_primary_key: false, extra: null, comment: column.comment })),
        "mysql",
      ),
      indexes: [],
      foreignKeys: [],
      triggers: [],
      loadedMetadataFacets: ["columns", "comment"],
    };
  }

  it("revalidates an explicitly clean restored snapshot", async () => {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet) => ({ value: facet === "columns" ? rebuiltColumns : facet === "comment" ? "" : [], cacheStatus: "remote" }));
    const root = await mountStructureEditor(restoredDraft(false));
    await vi.waitFor(() => expect(Array.from(root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")).map((input) => input.value)).toContain("email"));
    expect(columnsFacetCalls()).toHaveLength(1);
  });

  it("loads missing indexes for legacy field-tab drafts without overwriting pending columns", async () => {
    const indexes = [{ name: "legacy_id_idx", columns: ["id"], is_unique: false, is_primary: false }];
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet) => ({ value: facet === "columns" ? rebuiltColumns : facet === "indexes" ? indexes : facet === "comment" ? "" : [], cacheStatus: "remote" }));
    const draft = restoredDraft(true);
    delete draft.loadedMetadataFacets;
    draft.columns[0].name = "local_id";
    const root = await mountStructureEditor(draft);
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("[data-index-name-input]")?.value).toBe("legacy_id_idx"));
    const field = root.querySelector<HTMLInputElement>("[data-column-name-input]")!;
    expect(field.value).toBe("local_id");
    expect(field.closest("tr")?.classList.contains("structure-column-index-key")).toBe(true);
    expect(columnsFacetCalls()).toHaveLength(0);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it.each([true, undefined])("preserves restored edits when dirty is %s", async (dirty) => {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet) => ({ value: facet === "columns" ? rebuiltColumns : facet === "comment" ? "" : [], cacheStatus: "remote" }));
    const draft = restoredDraft(dirty);
    draft.columns[0].name = "local_edit";
    const root = await mountStructureEditor(draft);
    await settle();
    expect(root.querySelector<HTMLInputElement>("[data-column-name-input]")?.value).toBe("local_edit");
    expect(columnsFacetCalls()).toHaveLength(0);
  });

  it("preserves an edit started while restored snapshot validation is pending", async () => {
    let resolveColumns!: (value: unknown) => void;
    mocks.loadObjectMetadataFacet.mockImplementation((_request, facet) =>
      facet === "columns"
        ? new Promise((resolve) => {
            resolveColumns = resolve;
          })
        : Promise.resolve({ value: facet === "comment" ? "" : [], cacheStatus: "remote" }),
    );
    const root = await mountStructureEditor(restoredDraft(false));
    await vi.waitFor(() => expect(resolveColumns).toBeDefined());
    const input = root.querySelector<HTMLInputElement>("[data-column-name-input]")!;
    input.value = "local_edit";
    input.dispatchEvent(new Event("input"));
    await settle();
    resolveColumns({ value: rebuiltColumns, cacheStatus: "remote" });
    await settle();
    expect(root.querySelector<HTMLInputElement>("[data-column-name-input]")?.value).toBe("local_edit");
  });
});
