// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-charset-test",
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

type ColumnSeed = { name: string; originalName: string };

/**
 * Mount the editor in edit mode over `columns`. The column name the user typed
 * is `name`; `originalName` is the metadata name the draft was hydrated from.
 */
function draftWithColumns(columns: ColumnSeed[]) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: columns.map((column, index) => ({
      id: `existing:${column.originalName}`,
      name: column.name,
      dataType: "int",
      isNullable: true,
      defaultValue: "",
      comment: "",
      isPrimaryKey: false,
      characterSet: "",
      collation: "",
      extra: {},
      original: {
        name: column.originalName,
        data_type: "int",
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

/** Column names exactly as they reached the DDL builder. */
async function previewColumnNames(): Promise<string[]> {
  await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled(), { timeout: 3000 });
  const options = mocks.buildTableStructureChangeSql.mock.calls.at(-1)![0] as { columns: Array<{ name: string }> };
  return options.columns.map((column) => column.name);
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

describe("TableStructureEditor column name whitespace", () => {
  // MySQL rejects identifiers that end with a space (ERROR 1166 "Incorrect column
  // name"), so a pasted name carrying a trailing space produced an unexecutable
  // `ALTER TABLE ... CHANGE COLUMN ...` statement reported as "可执行".
  it("trims a user-entered trailing space before the name reaches the DDL builder", async () => {
    await mountEditor(draftWithColumns([{ name: "device_app_face_status ", originalName: "app_auth_status" }]));

    expect(await previewColumnNames()).toEqual(["device_app_face_status"]);
  });

  it("drops trailing whitespace a user pasted around a renamed column", async () => {
    await mountEditor(draftWithColumns([{ name: "display_name\t ", originalName: "name" }]));

    expect(await previewColumnNames()).toEqual(["display_name"]);
  });

  it("trims the visible field on blur so the input matches the generated SQL", async () => {
    const root = await mountEditor(draftWithColumns([{ name: "app_auth_status", originalName: "app_auth_status" }]));
    const input = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    expect(input).not.toBeNull();

    input!.value = "device_app_face_status ";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input!.dispatchEvent(new Event("blur"));
    await nextTick();

    expect(input!.value).toBe("device_app_face_status");
  });

  // Metadata-backed names must stay byte-exact: MySQL keeps leading spaces in a
  // backtick-quoted identifier, so rewriting a name the user never touched would
  // turn every unrelated edit into a bogus rename
  // (see crates/dbx-core/tests/live_mysql_column_name_whitespace.rs, #9654).
  it("leaves an untouched metadata column name byte-exact", async () => {
    const draft = draftWithColumns([{ name: "  content1", originalName: "  content1" }]);
    draft.columns[0]!.comment = "leading space kept";
    await mountEditor(draft);

    expect(await previewColumnNames()).toEqual(["  content1"]);
  });
});
