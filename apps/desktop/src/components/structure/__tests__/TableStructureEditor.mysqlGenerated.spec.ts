// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-generated-test",
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
    SquareFunction: Icon,
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

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

type ColumnSeed = {
  name: string;
  extra?: Record<string, unknown>;
  originalExtra?: string | null;
  originalDefault?: string | null;
  hasOriginal?: boolean;
};

function draftWithColumns(columns: ColumnSeed[]) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: columns.map((column, index) => ({
      id: column.hasOriginal === false ? `new:${index}` : `existing:${column.name}`,
      name: column.name,
      dataType: "int",
      isNullable: true,
      defaultValue: "",
      comment: "",
      isPrimaryKey: false,
      characterSet: "",
      collation: "",
      extra: column.extra ?? {},
      defaultValue: column.originalDefault ?? "",
      original: {
        name: column.name,
        data_type: "int",
        is_nullable: true,
        column_default: column.originalDefault ?? null,
        is_primary_key: false,
        extra: column.originalExtra ?? null,
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
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

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
  return root;
}

async function lastPreviewColumns(): Promise<Array<{ name: string; defaultValue: string; extra: Record<string, unknown> }>> {
  await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled(), { timeout: 3000 });
  await nextTick();
  const options = mocks.buildTableStructureChangeSql.mock.calls.at(-1)![0] as {
    columns: Array<{ name: string; defaultValue: string; extra: Record<string, unknown> }>;
  };
  return options.columns;
}

/** Wait until the debounced SQL preview submitted a newer request than `calls`. */
async function waitForPreviewCalls(calls: number): Promise<void> {
  await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBeGreaterThan(calls), { timeout: 3000 });
  await nextTick();
}

function virtualCheckbox(root: HTMLElement): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('label[title="structureEditor.virtual"] input');
  expect(input).not.toBeNull();
  return input!;
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

describe("TableStructureEditor MySQL generated columns", () => {
  it("shows a hydrated generated column as checked with its expression", async () => {
    const root = await mountEditor(
      draftWithColumns([
        {
          name: "total",
          extra: { generated: { expression: "`price` * `quantity`", storage: "STORED" } },
          originalExtra: "GENERATED ALWAYS AS (`price` * `quantity`) STORED",
        },
      ]),
    );

    expect(virtualCheckbox(root).checked).toBe(true);
    const expressionInput = root.querySelector<HTMLInputElement>("[data-mysql-generated-expression]");
    expect(expressionInput?.value).toBe("`price` * `quantity`");
  });

  it("unchecking a generated column sends an explicit empty expression (removal)", async () => {
    const root = await mountEditor(
      draftWithColumns([
        {
          name: "total",
          extra: { generated: { expression: "`price` * `quantity`", storage: "STORED" } },
          originalExtra: "GENERATED ALWAYS AS (`price` * `quantity`) STORED",
        },
      ]),
    );

    const checkbox = virtualCheckbox(root);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    const columns = await lastPreviewColumns();
    expect(columns[0]!.extra.generated).toEqual({ expression: "" });
  });

  it("checking virtual keeps conflicting attributes in the draft until the expression is active", async () => {
    const root = await mountEditor(
      draftWithColumns([
        {
          name: "total",
          extra: { autoIncrement: true, onUpdateCurrentTimestamp: true },
          originalExtra: "auto_increment on update current_timestamp",
        },
      ]),
    );

    const checkbox = virtualCheckbox(root);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    // Expression still empty: the attribute is not active, so the conflicting
    // attributes remain in the payload untouched.
    let calls = mocks.buildTableStructureChangeSql.mock.calls.length;
    await waitForPreviewCalls(calls);
    let columns = await lastPreviewColumns();
    expect(columns[0]!.extra.generated).toEqual({ expression: "", storage: "STORED" });
    expect(columns[0]!.extra.autoIncrement).toBe(true);
    expect(columns[0]!.extra.onUpdateCurrentTimestamp).toBe(true);

    // Fill the expression: the attribute becomes active and the conflicting
    // attributes are stripped from the SQL payload (MySQL rejects them on
    // generated columns).
    const input = root.querySelector<HTMLInputElement>("[data-mysql-generated-expression]");
    expect(input).not.toBeNull();
    input!.value = "`price` * `quantity`";
    input!.dispatchEvent(new Event("input"));

    calls = mocks.buildTableStructureChangeSql.mock.calls.length;
    await waitForPreviewCalls(calls);
    columns = await lastPreviewColumns();
    expect(columns[0]!.extra.generated).toEqual({ expression: "`price` * `quantity`", storage: "STORED" });
    expect(columns[0]!.extra.autoIncrement).toBeUndefined();
    expect(columns[0]!.extra.onUpdateCurrentTimestamp).toBeUndefined();
    // The expression editor entry is visible while the checkbox stays checked.
    expect(root.querySelector("[data-mysql-generated-expression-trigger]")).not.toBeNull();
  });

  it("unchecking virtual restores the original defaults instead of silently dropping them", async () => {
    const root = await mountEditor(
      draftWithColumns([
        {
          name: "total",
          extra: { autoIncrement: true },
          originalExtra: "auto_increment",
          originalDefault: "0",
        },
      ]),
    );

    const checkbox = virtualCheckbox(root);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    // While the attribute is not active yet, the original default and
    // AUTO_INCREMENT stay in the payload — checking must not erase them.
    const calls = mocks.buildTableStructureChangeSql.mock.calls.length;
    await waitForPreviewCalls(calls);
    const columns = await lastPreviewColumns();
    expect(columns[0]!.extra.generated).toEqual({ expression: "", storage: "STORED" });
    expect(columns[0]!.extra.autoIncrement).toBe(true);
    expect(columns[0]!.defaultValue).toBe("0");

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    // Unchecking restores the exact pre-check state: no pending change at
    // all, so the preview stops requesting SQL and saving emits no MODIFY
    // that would silently drop the default.
    const callsAfterUncheck = mocks.buildTableStructureChangeSql.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBe(callsAfterUncheck);
    const pending = root.querySelector("[data-mysql-generated-expression-trigger]");
    expect(pending).toBeNull();
  });

  it("re-checking virtual after an accidental uncheck restores the original expression", async () => {
    const root = await mountEditor(
      draftWithColumns([
        {
          name: "total",
          extra: { generated: { expression: "`price` * `quantity`", storage: "STORED" } },
          originalExtra: "GENERATED ALWAYS AS (`price` * `quantity`) STORED",
        },
      ]),
    );

    const checkbox = virtualCheckbox(root);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await nextTick();

    // The original expression and storage survive the uncheck/re-check cycle.
    const expressionInput = root.querySelector<HTMLInputElement>("[data-mysql-generated-expression]");
    expect(expressionInput?.value).toBe("`price` * `quantity`");

    // The restored draft equals the original definition, so no change is
    // pending and the preview stops requesting SQL — no spurious MODIFY.
    const calls = mocks.buildTableStructureChangeSql.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBe(calls);
  });

  it("unchecking virtual on a plain column leaves no generated payload", async () => {
    const root = await mountEditor(draftWithColumns([{ name: "total" }]));

    const checkbox = virtualCheckbox(root);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    const calls = mocks.buildTableStructureChangeSql.mock.calls.length;
    await waitForPreviewCalls(calls);
    const columns = await lastPreviewColumns();
    expect(columns[0]!.extra.generated).toEqual({ expression: "", storage: "STORED" });

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    // Back to the untouched draft: no change is pending, so the preview
    // stops requesting SQL entirely.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBe(calls + 1);
  });
});
