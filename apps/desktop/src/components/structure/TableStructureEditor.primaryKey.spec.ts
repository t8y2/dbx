// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-test",
    name: "Dameng",
    db_type: "dameng",
    driver_label: "Dameng",
  },
  ensureConnected: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  getTablePartitionStatus: vi.fn(),
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
    Copy: Icon,
    Database: Icon,
    Info: Icon,
    KeyRound: Icon,
    ListChevronsUpDown: Icon,
    Loader2: Icon,
    Maximize2: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    Save: Icon,
    Search: Icon,
    Settings: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
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
        (props, { attrs, emit }) =>
        () =>
          h("button", {
            ...attrs,
            type: "button",
            "data-searchable-select": "true",
            "data-model-value": props.modelValue,
            "data-options": JSON.stringify(props.options),
            "data-allow-custom": String(props.allowCustom),
            onClick: () => emit("update:modelValue", "custom_domain"),
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
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [] },
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
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

function draft(isPrimaryKey = false) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: [
      {
        id: "existing:id",
        name: "id",
        dataType: "INT",
        isNullable: !isPrimaryKey,
        defaultValue: "",
        comment: "",
        isPrimaryKey,
        extra: {},
        original: {
          name: "id",
          data_type: "INT",
          is_nullable: !isPrimaryKey,
          column_default: null,
          is_primary_key: isPrimaryKey,
          extra: null,
          comment: null,
        },
        originalPosition: 0,
        markedForDrop: false,
      },
    ],
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

async function mountEditor(databaseType: "sqlserver" | "postgres" | "sqlite" | "oracle" | "dameng" | "duckdb" | "informix", isPrimaryKey = false, options: { database?: string; dynamicTypes?: string[] } = {}) {
  mocks.connection.db_type = databaseType;
  mocks.connection.name = databaseType;
  mocks.connection.driver_label = databaseType;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue(options.dynamicTypes ?? []);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: options.database ?? "test",
    schema: "SYSDBA",
    tableName: "users",
    draft: draft(isPrimaryKey),
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

async function mountLoadingEditor(initialTab: "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl") {
  mocks.connection.db_type = "postgres";
  mocks.connection.name = "postgres";
  mocks.connection.driver_label = "postgres";
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({ value: facet === "comment" ? "" : [], cacheStatus: "remote" }));

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "public",
    tableName: "users",
    initialTab,
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

function columnCheckbox(root: HTMLElement, header: string): HTMLInputElement {
  const headerIndex = Array.from(root.querySelectorAll("thead th")).findIndex((cell) => cell.textContent?.trim() === header);
  if (headerIndex < 0) throw new Error(`Missing ${header} column`);
  const row = root.querySelector<HTMLElement>('[data-column-row-index="0"]');
  const cell = row?.querySelectorAll("td")[headerIndex];
  const checkbox = cell?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`Missing ${header} checkbox`);
  return checkbox;
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing ${text} button`);
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
  mocks.invalidateObjectDdl.mockResolvedValue(undefined);
  mocks.loadObjectMetadataFacet.mockResolvedValue({ value: [], cacheStatus: "remote" });
  // TableStructureEditor probes the partition status for PostgreSQL tables
  // (PR #6361); a resolved non-partitioned result keeps metadata loads on the
  // original facet expectations unchanged.
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor primary key editing", () => {
  it("enables the primary-key checkbox for an existing Dameng column and makes it not null", async () => {
    const root = await mountEditor("dameng");
    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey");
    const nullable = columnCheckbox(root, "structureEditor.nullable");

    expect(primaryKey.disabled).toBe(false);
    expect(nullable.checked).toBe(true);

    primaryKey.checked = true;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(primaryKey.checked).toBe(true);
    expect(nullable.checked).toBe(false);
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled());
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ isPrimaryKey: true, isNullable: false })],
      }),
    );
  });

  it("keeps the primary-key checkbox disabled for an existing Oracle column", async () => {
    const root = await mountEditor("oracle");

    expect(columnCheckbox(root, "structureEditor.primaryKey").disabled).toBe(true);
  });

  it("allows an existing Dameng primary key to be cleared", async () => {
    const root = await mountEditor("dameng", true);
    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey");

    expect(primaryKey.disabled).toBe(false);
    expect(primaryKey.checked).toBe(true);

    primaryKey.checked = false;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(primaryKey.checked).toBe(false);
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled());
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ isPrimaryKey: false })],
      }),
    );
  });

  it("keeps the current SQL preview visible while a newer preview is loading", async () => {
    const root = await mountEditor("dameng", true);
    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey");
    const nullable = columnCheckbox(root, "structureEditor.nullable");
    const firstSql = "ALTER TABLE users DROP CONSTRAINT users_pkey;";

    mocks.buildTableStructureChangeSql.mockResolvedValueOnce({ statements: [firstSql], warnings: [] });
    primaryKey.checked = false;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(root.textContent).toContain(firstSql));

    let resolveLatestPreview!: (value: { statements: string[]; warnings: string[] }) => void;
    mocks.buildTableStructureChangeSql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLatestPreview = resolve;
        }),
    );
    nullable.checked = true;
    nullable.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(buttonWithText(root, "structureEditor.copySql").disabled).toBe(true);
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(true);

    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledTimes(2));
    expect(root.textContent).toContain(firstSql);
    expect(root.textContent).not.toContain("structureEditor.noChanges");

    resolveLatestPreview({ statements: ["ALTER TABLE users ALTER COLUMN id DROP NOT NULL;"], warnings: [] });
    await vi.waitFor(() => expect(root.textContent).toContain("ALTER TABLE users ALTER COLUMN id DROP NOT NULL;"));
    expect(buttonWithText(root, "structureEditor.copySql").disabled).toBe(false);
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(false);
  });

  it("debounces SQL preview generation while editing a column name", async () => {
    vi.useFakeTimers();
    const root = await mountEditor("dameng");
    const nameInput = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    if (!nameInput) throw new Error("Missing column name input");

    nameInput.value = "user";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);

    nameInput.value = "user_id";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await vi.advanceTimersByTimeAsync(299);

    expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await nextTick();

    expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledTimes(1);
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ name: "user_id" })],
      }),
    );
  });
});

describe("TableStructureEditor data type options", () => {
  it("keeps dynamic Dameng types first and deduplicates fallback types case-insensitively", async () => {
    const root = await mountEditor("dameng", false, {
      database: "dynamic-types-5275",
      dynamicTypes: ["VARCHAR", "CUSTOM_DM_TYPE", "NUMBER"],
    });
    const picker = root.querySelector<HTMLElement>('[data-searchable-select="true"]');
    if (!picker) throw new Error("Missing data type picker");

    await vi.waitFor(() => expect(JSON.parse(picker.dataset.options ?? "[]").slice(0, 3)).toEqual(["VARCHAR", "CUSTOM_DM_TYPE", "NUMBER"]));
    const options = JSON.parse(picker.dataset.options ?? "[]") as string[];
    expect(options.filter((option) => option.toLowerCase() === "varchar")).toEqual(["VARCHAR"]);
    expect(options.filter((option) => option.toLowerCase() === "number")).toEqual(["NUMBER"]);
    expect(options).toContain("longvarchar");
  });

  it("continues to accept manually entered Dameng data types", async () => {
    const root = await mountEditor("dameng", false, { database: "manual-type-5275" });
    const picker = root.querySelector<HTMLButtonElement>('[data-searchable-select="true"]');
    if (!picker) throw new Error("Missing data type picker");

    expect(picker.dataset.allowCustom).toBe("true");
    picker.click();
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(expect.objectContaining({ columns: [expect.objectContaining({ dataType: "custom_domain" })] })));
  });
});

describe("TableStructureEditor local column order notice", () => {
  it.each(["sqlserver", "postgres", "sqlite", "oracle", "dameng", "duckdb", "informix"] as const)("does not show the reorder notice when adding a %s column", async (databaseType) => {
    const root = await mountEditor(databaseType);
    const addColumnButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("structureEditor.addColumn"));
    if (!addColumnButton) throw new Error("Missing add column button");

    addColumnButton.click();
    await nextTick();

    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("TableStructureEditor horizontal scrolling", () => {
  it("shows a fixed scrollbar for overflowing columns and syncs thumb dragging", async () => {
    const root = await mountEditor("postgres");
    const scroller = root.querySelector<HTMLElement>(".structure-table-scroller");
    if (!scroller) throw new Error("Missing structure table scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 1200 },
      scrollLeft: { configurable: true, value: 200, writable: true },
    });

    scroller.dispatchEvent(new Event("scroll"));
    await nextTick();
    await nextTick();

    const track = root.querySelector<HTMLElement>(".structure-horizontal-scrollbar");
    const thumb = root.querySelector<HTMLElement>(".structure-horizontal-scrollbar__thumb");
    if (!track || !thumb) throw new Error("Missing fixed horizontal scrollbar");
    expect(Number.parseFloat(thumb.style.width)).toBeCloseTo(100 / 3);
    expect(Number.parseFloat(thumb.style.left)).toBeCloseTo(100 / 6);

    track.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 10 });
    document.body.style.userSelect = "text";
    track.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 60, isPrimary: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, isPrimary: true }));

    expect(scroller.scrollLeft).toBeCloseTo(600);
    expect(document.body.style.userSelect).toBe("none");
    window.dispatchEvent(new PointerEvent("pointerup", { isPrimary: true }));
    expect(document.body.style.userSelect).toBe("text");
  });
});

describe("TableStructureEditor metadata loading", () => {
  it("opens the initial DDL tab without starting structure metadata loads", async () => {
    await mountLoadingEditor("ddl");

    await vi.waitFor(() => expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1));
    expect(mocks.loadObjectMetadataFacet).not.toHaveBeenCalled();
  });

  it.each([
    ["columns", ["columns", "comment"]],
    ["indexes", ["columns", "indexes", "comment"]],
    ["foreignKeys", ["columns", "foreign-keys", "comment"]],
    ["triggers", ["triggers", "comment"]],
  ] as const)("loads only the required facets for the initial %s tab", async (initialTab, expectedFacets) => {
    await mountLoadingEditor(initialTab);

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(expectedFacets.length));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1])).toEqual(expectedFacets);
    expect(mocks.loadObjectDdl).not.toHaveBeenCalled();
  });

  it("loads index metadata when an initialized column draft opens the indexes tab", async () => {
    mocks.connection.db_type = "postgres";
    mocks.connection.name = "postgres";
    mocks.connection.driver_label = "postgres";
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.listDataTypes.mockResolvedValue([]);
    mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value:
        facet === "indexes"
          ? [
              {
                name: "idx_users_id",
                columns: ["id"],
                is_unique: false,
                is_primary: false,
              },
            ]
          : facet === "comment"
            ? ""
            : [],
      cacheStatus: "remote",
    }));

    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "indexes",
      draft: {
        ...draft(),
        loadedMetadataFacets: ["columns", "comment"],
      },
    });
    mountedApps.push(app);
    app.mount(root);
    await nextTick();
    await Promise.resolve();
    await nextTick();

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(1));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1])).toEqual(["indexes"]);
    await vi.waitFor(() => expect(root.querySelector('[data-index-row-index="0"]')).not.toBeNull());
  });
});
