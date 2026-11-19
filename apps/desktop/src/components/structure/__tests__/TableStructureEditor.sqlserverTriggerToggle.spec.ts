// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "sqlserver-trigger-toggle",
    name: "SQL Server",
    db_type: "sqlserver",
    driver_label: "SQL Server",
    driver_profile: "sqlserver",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  toast: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  };
});

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
      props: { disabled: { type: Boolean, default: false } },
      setup:
        (props, { attrs, slots }) =>
        () =>
          h("button", { ...attrs, disabled: props.disabled }, slots.default?.()),
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
          h("span", { ...attrs, "data-badge": "true" }, slots.default?.()),
    }),
  };
});

vi.mock("@/components/ui/tabs", async () => {
  const { computed, defineComponent, h, inject, provide, ref } = await import("vue");
  const TabsSelectKey = Symbol("tabs:select");
  const TabsActiveKey = Symbol("tabs:active");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const Tabs = defineComponent({
    name: "MockTabs",
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    setup: (props, { attrs, slots, emit }) => {
      provide(TabsSelectKey, (value: string) => emit("update:modelValue", value));
      provide(
        TabsActiveKey,
        computed(() => props.modelValue),
      );
      return () => h("div", attrs, slots.default?.());
    },
  });
  const TabsContent = defineComponent({
    name: "MockTabsContent",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup: (props, { attrs, slots }) => {
      const active = inject<{ value: string }>(TabsActiveKey, ref(""));
      return () => h("div", attrs, active.value === props.value ? slots.default?.() : undefined);
    },
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup: (props, { attrs, slots }) => {
      const select = inject<(value: string) => void>(TabsSelectKey, () => {});
      return () => h("button", { ...attrs, type: "button", "data-tab-trigger": props.value, onClick: () => select(props.value) }, slots.default?.());
    },
  });
  return { Tabs, TabsContent, TabsList: Div, TabsTrigger };
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
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
  }),
}));

vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({ add: vi.fn() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      structureEditorDensity: "compact",
      enableExtendedTableProperties: false,
      useTableStructureDirectSave: false,
      excludeDdlStorage: false,
    },
    updateEditorSettings: vi.fn(),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
  executeQuery: mocks.executeQuery,
  listTriggers: vi.fn().mockResolvedValue([{ name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true, statement: "BEGIN SET NOCOUNT ON; END" }]),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/table/tableStructureMetadataLoading", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table/tableStructureMetadataLoading")>();
  return {
    ...actual,
    loadObjectMetadataFacet: mocks.loadObjectMetadataFacet,
    invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache,
    invalidateTableMetadataCache: mocks.invalidateTableMetadataCache,
  };
});

let app: App | undefined;
let pinia: ReturnType<typeof createPinia>;

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  mocks.listDataTypes.mockResolvedValue(["int", "varchar", "datetime"]);
  mocks.loadObjectMetadataFacet.mockImplementation((_request: any, facet: string) =>
    Promise.resolve({
      value:
        facet === "columns"
          ? [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true }]
          : facet === "triggers"
            ? [{ name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true, statement: "BEGIN SET NOCOUNT ON; END" }]
            : facet === "comment"
              ? ""
              : [],
      cacheStatus: "remote",
    }),
  );
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("TableStructureEditor SQL Server trigger enable/disable toggle", () => {
  it("renders trigger enabled toggle button for SQL Server and toggles state on click", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    app = createApp({
      render: () =>
        h(
          TooltipProvider,
          {},
          {
            default: () =>
              h(TableStructureEditor, {
                connectionId: mocks.connection.id,
                database: "testdb",
                schema: "dbo",
                tableName: "orders",
                initialTab: "triggers",
              }),
          },
        ),
    });
    app.use(pinia);
    app.component("LightTooltip", LightTooltip);
    app.mount(root);

    // Wait for triggers tab and metadata to load
    await vi.waitFor(() => {
      expect(root.textContent).toContain("trg_orders_audit");
    });

    // The trigger row should contain a Button for enabled state (not a static Badge)
    const toggleButton = await vi.waitFor(() => {
      const btn = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === "damengJobAdmin.enabled");
      expect(btn).toBeTruthy();
      return btn!;
    });

    expect(toggleButton).toBeDefined();
    expect(toggleButton.disabled).toBe(false);

    // Clicking the toggle button should switch state to disabled
    toggleButton.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(toggleButton.textContent?.trim()).toBe("damengJobAdmin.disabled");
    });
  });
});
