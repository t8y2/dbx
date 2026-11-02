// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-row-height-test",
    name: "Dameng",
    db_type: "dameng",
    driver_profile: "dameng",
    driver_label: "Dameng",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  executeBatch: vi.fn(),
  getTableOwner: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));

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
        (props, { attrs, emit }) =>
        () =>
          h("button", {
            ...attrs,
            type: "button",
            "data-searchable-select": "true",
            "data-model-value": props.modelValue,
            onClick: () => emit("update:modelValue", "custom"),
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
  const SelectTrigger = defineComponent({
    name: "SelectTrigger",
    inheritAttrs: false,
    props: {
      size: { type: String, default: "default" },
    },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h("button", { ...attrs, "data-size": props.size, "data-slot": "select-trigger" }, slots.default?.()),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger, SelectValue: Div };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));

let mockDensity = "compact";
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { structureEditorDensity: mockDensity, sqlFormatter: {}, tableColumnTemplateFields: [], generateSqlQuoteIdentifiers: true },
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
  executeBatch: mocks.executeBatch,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

function draftWithColumns(columns: Array<{ name: string; dataType: string }>) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: columns.map((col, index) => ({
      id: `existing:${col.name}`,
      name: col.name,
      dataType: col.dataType,
      isNullable: true,
      defaultValue: "",
      comment: "",
      isPrimaryKey: false,
      characterSet: "",
      collation: "",
      extra: {},
      original: {
        name: col.name,
        data_type: col.dataType,
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      originalPosition: index,
      markedForDrop: false,
    })),
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

async function mountEditor(draft: ReturnType<typeof draftWithColumns>) {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([
    { name: "VARCHAR", full_type: "VARCHAR(255)" },
    { name: "TIMESTAMP", full_type: "TIMESTAMP" },
    { name: "TEXT", full_type: "TEXT" },
  ]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "test",
    tableName: "mixed_types_table",
    draft,
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDensity = "compact";
  mocks.connection.db_type = "dameng";
  mocks.connection.driver_profile = "dameng";
  mocks.getTableOwner.mockResolvedValue("dameng");
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE mixed_types_table (del_flag VARCHAR(1) BYTE, create_time TIMESTAMP)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_options: unknown, facet: string) => {
    if (facet === "owner") return { value: "app_user", cacheStatus: "remote" };
    return { value: [], cacheStatus: "remote" };
  });
  mocks.executeBatch.mockResolvedValue({ affected_rows: 0 });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor row height consistency (#13659)", () => {
  it("applies --structure-column-row-height CSS variable and uniform row heights across mixed data types", async () => {
    const root = await mountEditor(
      draftWithColumns([
        { name: "del_flag", dataType: "VARCHAR(1) BYTE" },
        { name: "create_by", dataType: "VARCHAR(64) BYTE" },
        { name: "create_time", dataType: "TIMESTAMP" },
        { name: "remark", dataType: "TEXT" },
      ]),
    );

    // Root element should define --structure-column-row-height: 33px (24 control + 4*2 cellPaddingY + 1 border)
    const rootEl = root.querySelector("[data-structure-density='compact']") as HTMLElement;
    expect(rootEl).not.toBeNull();
    expect(rootEl.style.getPropertyValue("--structure-column-row-height")).toBe("33px");

    // RecycleScroller should carry --structure-column-row-height style
    const scroller = root.querySelector(".structure-column-virtual-scroller") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.style.getPropertyValue("--structure-column-row-height")).toBe("33px");

    // All row tables and tr elements must have uniform height matching the 33px slot
    const rowTables = root.querySelectorAll(".structure-column-virtual-row-table") as NodeListOf<HTMLElement>;
    expect(rowTables.length).toBeGreaterThan(0);
    for (const table of Array.from(rowTables)) {
      expect(table.style.height).toBe("33px");
    }

    const rowTrs = root.querySelectorAll(".structure-column-virtual-row-table tr[data-column-id]") as NodeListOf<HTMLElement>;
    expect(rowTrs.length).toBeGreaterThan(0);
    for (const tr of Array.from(rowTrs)) {
      expect(tr.style.height).toBe("33px");
    }

    // Length unit SelectTrigger in VARCHAR rows should have size="sm"
    const triggers = root.querySelectorAll("[data-slot='select-trigger']");
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of Array.from(triggers)) {
      expect(trigger.getAttribute("data-size")).toBe("sm");
    }
  });

  it("updates --structure-column-row-height and row heights when density changes to standard", async () => {
    mockDensity = "standard";
    const root = await mountEditor(
      draftWithColumns([
        { name: "id", dataType: "BIGINT" },
        { name: "name", dataType: "VARCHAR(50)" },
      ]),
    );

    // Standard density: controlHeight 28 + cellPaddingY 5 * 2 + 1 border = 39px
    const rootEl = root.querySelector("[data-structure-density='standard']") as HTMLElement;
    expect(rootEl).not.toBeNull();
    expect(rootEl.style.getPropertyValue("--structure-column-row-height")).toBe("39px");

    const rowTables = root.querySelectorAll(".structure-column-virtual-row-table") as NodeListOf<HTMLElement>;
    for (const table of Array.from(rowTables)) {
      expect(table.style.height).toBe("39px");
    }
  });

  it("allocates extra height for Postgres geometry columns with variable geometry hint", async () => {
    mockDensity = "compact";
    mocks.connection.db_type = "postgres";
    mocks.connection.driver_profile = "postgres";
    mocks.getTableOwner.mockResolvedValue("postgres");
    const root = await mountEditor(
      draftWithColumns([
        { name: "id", dataType: "BIGINT" },
        { name: "geom", dataType: "geometry(,4326)" },
      ]),
    );

    const idRow = root.querySelector("tr[data-column-id='existing:id']") as HTMLElement;
    const geomRow = root.querySelector("tr[data-column-id='existing:geom']") as HTMLElement;
    expect(idRow).not.toBeNull();
    expect(geomRow).not.toBeNull();
    expect(idRow.style.height).toBe("33px");
    const geomHeight = parseInt(geomRow.style.height, 10);
    expect(geomHeight).toBeGreaterThan(33);
  });
});
