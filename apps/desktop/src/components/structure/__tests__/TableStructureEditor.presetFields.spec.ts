// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-preset-fields-test",
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
  toast: vi.fn(),
  editorSettings: {
    structureEditorDensity: "compact",
    sqlFormatter: {},
    tableColumnTemplateFields: ["created_at | mysql:datetime | default:CURRENT_TIMESTAMP | comment:Creation time", "updated_at | mysql:datetime | default:CURRENT_TIMESTAMP | comment:Update time", "deleted | mysql:tinyint | default:0 | comment:Soft delete flag"],
    generateSqlQuoteIdentifiers: true,
  },
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: { items: { type: Array, default: () => [] } },
      setup:
        (props, { slots }) =>
        () =>
          h("div", [slots.before?.(), ...props.items.map((item, index) => slots.default?.({ item, index, active: true })), slots.after?.()]),
    }),
    DynamicScroller: defineComponent({
      props: { items: { type: Array, default: () => [] } },
      setup:
        (props, { slots }) =>
        () =>
          h("div", [slots.before?.(), ...props.items.map((item, index) => slots.default?.({ item, index, active: true })), slots.after?.()]),
    }),
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
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
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

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

function draftWithColumns(columnNames: string[]) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: columnNames.map((name, index) => ({
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
      original: {
        name,
        data_type: "int",
        is_nullable: true,
        column_default: null,
        is_primary_key: index === 0,
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

async function mountEditor(options: { tableName: string; draft: ReturnType<typeof draftWithColumns>; onOpenSettings?: (...args: any[]) => void }) {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "test",
    tableName: options.tableName,
    draft: options.draft,
    onOpenSettings: options.onOpenSettings,
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await vi.waitFor(() => expect(root.querySelector("[data-column-name-input]")).not.toBeNull(), { timeout: 3000 });
  return root;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) {
    app.unmount();
  }
  document.body.innerHTML = "";
});

describe("TableStructureEditor preset fields (#12297)", () => {
  it("renders insert preset fields button in edit mode and inserts non-duplicate fields", async () => {
    // Existing table has id and created_at
    const draft = draftWithColumns(["id", "created_at"]);
    const root = await mountEditor({ tableName: "user", draft });

    // Find the insert preset fields button
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const templateButton = buttons.find((btn) => btn.textContent?.includes("structureEditor.columnTemplates"));
    expect(templateButton).toBeDefined();

    // Click insert preset fields
    templateButton!.click();
    await nextTick();

    // Should have inserted updated_at and deleted, while created_at is skipped because it already exists
    const columnInputs = [...root.querySelectorAll<HTMLInputElement>("[data-column-name-input]")];
    const columnNames = columnInputs.map((input) => input.value);
    expect(columnNames).toEqual(["id", "created_at", "updated_at", "deleted"]);
  });

  it("renders configure preset fields settings button in edit mode", async () => {
    const onOpenSettings = vi.fn();
    const draft = draftWithColumns(["id"]);
    const root = await mountEditor({ tableName: "user", draft, onOpenSettings });

    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const settingsButton = buttons.find((btn) => btn.getAttribute("aria-label") === "structureEditor.configureColumnTemplates");
    expect(settingsButton).toBeDefined();

    settingsButton!.click();
    await nextTick();

    expect(onOpenSettings).toHaveBeenCalledWith("data", "tableColumnTemplates");
  });
});
