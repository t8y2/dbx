// @vitest-environment happy-dom

import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "ddl-tab-lifecycle",
    name: "PostgreSQL",
    db_type: "postgres",
    driver_label: "PostgreSQL",
    driver_profile: "postgres",
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
    Keyboard: Icon,
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
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("span", attrs, slots.default?.()),
    }),
  };
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
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h("button", attrs),
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
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], theme: "default", fontSize: 13, fontFamily: "monospace" },
    updateEditorSettings: vi.fn(),
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/editor/editorThemes", () => ({
  editorFontTheme: vi.fn(() => []),
  loadEditorTheme: vi.fn(async () => []),
}));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({
  loadObjectMetadataFacet: mocks.loadObjectMetadataFacet,
  invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache,
}));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const DDL = "CREATE TABLE users (id bigint);";
let app: App | undefined;

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing ${text} button`);
  return button as HTMLButtonElement;
}

function selectTab(button: HTMLButtonElement) {
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
  mocks.getTableOwner.mockResolvedValue("app_user");
  mocks.loadObjectDdl.mockResolvedValue({ ddl: DDL, cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
    value: facet === "columns" ? [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true }] : facet === "comment" ? "" : facet === "owner" ? "app_user" : [],
    cacheStatus: "remote",
  }));
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("TableStructureEditor DDL tab lifecycle", () => {
  it("restores cached DDL after switching to columns and back", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "ddl",
    });
    app.mount(root);

    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL), { timeout: 5000 });

    const columnsTab = buttonWithText(root, "structureEditor.columns");
    selectTab(columnsTab);
    await nextTick();
    await vi.waitFor(() => expect(columnsTab.getAttribute("data-state")).toBe("active"));

    const inactiveDdlContainer = root.querySelector(".structure-ddl-editor");
    expect(inactiveDdlContainer).not.toBeNull();
    const inactiveDdlPanel = inactiveDdlContainer?.closest('[data-slot="tabs-content"]');
    expect(inactiveDdlPanel?.getAttribute("data-state")).toBe("inactive");
    expect(inactiveDdlPanel?.classList.contains("data-[state=inactive]:hidden")).toBe(true);
    await vi.waitFor(() => expect(inactiveDdlContainer?.querySelector(".cm-content")).toBeNull());

    selectTab(buttonWithText(root, "DDL"));
    await nextTick();

    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL), { timeout: 1000 });
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
  });
});
