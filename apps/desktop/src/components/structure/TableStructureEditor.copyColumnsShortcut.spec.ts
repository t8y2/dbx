// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: { id: "structure-test", name: "MySQL", db_type: "mysql", driver_label: "MySQL" },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  previewSqliteTableStructureChange: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  listDorisCatalogs: vi.fn(),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  getColumns: vi.fn(),
  editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], generateSqlQuoteIdentifiers: true },
  toast: vi.fn(),
}));

vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@lucide/vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lucide/vue")>();
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("span") });
  return new Proxy(actual as Record<string, unknown>, { get: (target, key) => target[key as string] ?? Icon });
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
          h("input", { ...attrs, value: props.modelValue, onInput: (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value) }),
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
          h("div", attrs, slots.default?.()),
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
  const Btn = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  });
  return { Tabs: Div, TabsContent: Div, TabsList: Div, TabsTrigger: Btn };
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
  const Btn = defineComponent({
    inheritAttrs: false,
    setup:
      (_p, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Btn, DropdownMenuTrigger: Div };
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
      name: "SearchableSelect",
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" }, options: { type: Array, default: () => [] }, allowCustom: { type: Boolean, default: false }, trimCustom: { type: Boolean, default: true } },
      emits: ["update:modelValue"],
      setup:
        (_props, { attrs }) =>
        () =>
          h("button", { ...attrs, type: "button", "data-searchable-select": "true" }),
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
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({ inheritAttrs: false, setup: () => () => null });
  return {
    // Render only an open marker, not the dialog body: the body pulls in heavy
    // metadata-driven UI that is irrelevant to the shortcut under test.
    Dialog: defineComponent({
      name: "Dialog",
      props: { open: { type: Boolean, default: false } },
      setup: (props) => () => (props.open ? h("div", { "data-testid": "open-dialog" }) : null),
    }),
    DialogContent: Div,
    DialogFooter: Div,
    DialogHeader: Div,
    DialogTitle: Div,
  };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
    getConfig: (id: string) => (id === mocks.connection.id ? mocks.connection : undefined),
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: mocks.editorSettings, updateEditorSettings: mocks.updateEditorSettings }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "default" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/backend/platform", () => ({ isMacOS: () => false }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: mocks.loadObjectDdl, invalidateObjectDdl: mocks.invalidateObjectDdl }));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  previewSqliteTableStructureChange: mocks.previewSqliteTableStructureChange,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
  listDorisCatalogs: mocks.listDorisCatalogs,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

function makeDraft() {
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
        isNullable: false,
        defaultValue: "",
        comment: "",
        isPrimaryKey: true,
        extra: {},
        original: { name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null },
        originalPosition: 0,
        markedForDrop: false,
      },
    ],
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

async function mountEditor() {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.listSchemas.mockResolvedValue([]);
  mocks.listTables.mockResolvedValue([]);
  mocks.getColumns.mockResolvedValue([]);

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "",
    tableName: "users",
    draft: makeDraft(),
  });
  app.component("LightTooltip", { template: "<span><slot /></span>" });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

function pressModShiftC(target: Element) {
  const event = new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: target, enumerable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor copy-fields-from-another-table shortcut (#13719)", () => {
  it("opens the copy-columns dialog on Ctrl/Cmd+Shift+C inside the editor", async () => {
    const root = await mountEditor();
    expect(root.querySelector('[data-testid="open-dialog"]')).toBeNull();
    // The keydown guard requires the event target to be inside the editor's root.
    const inner = root.querySelector("[data-structure-density]") ?? root;
    pressModShiftC(inner);
    await nextTick();
    await Promise.resolve();
    await nextTick();
    expect(root.querySelector('[data-testid="open-dialog"]')).not.toBeNull();
  });

  it("does not open the dialog without the shift modifier", async () => {
    const root = await mountEditor();
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: root, enumerable: true });
    window.dispatchEvent(event);
    await nextTick();
    expect(root.querySelector('[data-testid="open-dialog"]')).toBeNull();
  });

  it("does not open the dialog when the event originates outside the editor", async () => {
    const root = await mountEditor();
    const outside = document.createElement("div");
    document.body.append(outside);
    pressModShiftC(outside);
    await nextTick();
    expect(root.querySelector('[data-testid="open-dialog"]')).toBeNull();
  });
});
