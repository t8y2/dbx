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
      setup:
        (_props, { attrs }) =>
        () =>
          h("input", attrs),
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
      setup:
        (_props, { attrs }) =>
        () =>
          h("div", attrs),
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
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/backend/api", () => ({
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
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

async function mountEditor(databaseType: "dameng" | "oracle", isPrimaryKey = false) {
  mocks.connection.db_type = databaseType;
  mocks.connection.name = databaseType;
  mocks.connection.driver_label = databaseType;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
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

function columnCheckbox(root: HTMLElement, header: string): HTMLInputElement {
  const headerIndex = Array.from(root.querySelectorAll("thead th")).findIndex((cell) => cell.textContent?.trim() === header);
  if (headerIndex < 0) throw new Error(`Missing ${header} column`);
  const row = root.querySelector<HTMLElement>('[data-column-row-index="0"]');
  const cell = row?.querySelectorAll("td")[headerIndex];
  const checkbox = cell?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`Missing ${header} checkbox`);
  return checkbox;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
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
});
