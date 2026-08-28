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
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
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
        trimCustom: { type: Boolean, default: true },
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
            "data-trim-custom": String(props.trimCustom),
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
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
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

const mountedApps: App[] = [];

function draft(isPrimaryKey = false, identity?: { seed: number; increment: number }) {
  const isNullable = identity ? false : !isPrimaryKey;
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
        isNullable,
        defaultValue: "",
        comment: "",
        isPrimaryKey,
        extra: identity ? { autoIncrement: true, identity: { ...identity } } : {},
        original: {
          name: "id",
          data_type: "INT",
          is_nullable: isNullable,
          column_default: null,
          is_primary_key: isPrimaryKey,
          extra: identity ? `IDENTITY(${identity.seed}, ${identity.increment})` : null,
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

async function mountEditor(databaseType: "sqlserver" | "postgres" | "sqlite" | "oracle" | "oceanbase-oracle" | "iris" | "dameng" | "duckdb" | "informix", isPrimaryKey = false, options: { database?: string; dynamicTypes?: string[]; identity?: { seed: number; increment: number } } = {}) {
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
    draft: draft(isPrimaryKey, options.identity),
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

async function mountLoadingEditor(initialTab: "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl", owner = "app_user") {
  mocks.connection.db_type = "postgres";
  mocks.connection.name = "postgres";
  mocks.connection.driver_label = "postgres";
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({ value: facet === "comment" ? "" : facet === "owner" ? owner : [], cacheStatus: "remote" }));

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

function columnCheckbox(root: HTMLElement, header: string, rowIndex = 0): HTMLInputElement {
  const headerIndex = Array.from(root.querySelectorAll("thead th")).findIndex((cell) => cell.textContent?.trim() === header);
  if (headerIndex < 0) throw new Error(`Missing ${header} column`);
  const row = root.querySelector<HTMLElement>(`[data-column-row-index="${rowIndex}"]`);
  const cell = row?.querySelectorAll("td")[headerIndex];
  const checkbox = cell?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`Missing ${header} checkbox`);
  return checkbox;
}

function columnPropertyCheckbox(root: HTMLElement, title: string): HTMLInputElement {
  const checkbox = root.querySelector<HTMLInputElement>(`[data-column-row-index="0"] label[title="${title}"] input[type="checkbox"]`);
  if (!checkbox) throw new Error(`Missing ${title} checkbox`);
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
  mocks.invalidateObjectMetadataCache.mockResolvedValue(undefined);
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({ value: facet === "owner" ? "app_user" : [], cacheStatus: "remote" }));
  mocks.getTableOwner.mockResolvedValue("app_user");
  mocks.executeQuery.mockResolvedValue({
    columns: ["user", "host", "plugin"],
    rows: [
      ["app_user", "LOGIN", ""],
      ["reporting_role", "ROLE", ""],
    ],
  });
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
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
  it("allows enabling identity on an existing Dameng integer column", async () => {
    const root = await mountEditor("dameng");
    const identity = columnPropertyCheckbox(root, "structureEditor.identity");
    const nullable = columnCheckbox(root, "structureEditor.nullable");

    expect(identity.disabled).toBe(false);
    expect(nullable.checked).toBe(true);

    identity.checked = true;
    identity.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(identity.checked).toBe(true);
    expect(nullable.checked).toBe(false);
    expect(Array.from(root.querySelectorAll<HTMLInputElement>('[data-column-row-index="0"] input[type="number"]')).every((input) => !input.disabled)).toBe(true);
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled());
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [
          expect.objectContaining({
            isNullable: false,
            extra: expect.objectContaining({ autoIncrement: true, identity: { seed: 1, increment: 1 } }),
          }),
        ],
      }),
    );
  });

  it("allows disabling existing Dameng identity while keeping its parameters read-only", async () => {
    const root = await mountEditor("dameng", false, { identity: { seed: 10, increment: 2 } });
    const identity = columnPropertyCheckbox(root, "structureEditor.identity");
    const identityInputs = Array.from(root.querySelectorAll<HTMLInputElement>('[data-column-row-index="0"] input[type="number"]'));

    expect(identity.disabled).toBe(false);
    expect(identity.checked).toBe(true);
    expect(identityInputs).toHaveLength(2);
    expect(identityInputs.every((input) => input.disabled)).toBe(true);

    identity.checked = false;
    identity.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(identity.checked).toBe(false);
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled());
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ extra: expect.objectContaining({ autoIncrement: false, identity: undefined }) })],
      }),
    );
  });

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

  it("enables a primary key on an existing keyless Oracle column and makes it not null", async () => {
    const root = await mountEditor("oracle");
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

  it("keeps all primary-key checkboxes enabled while composing a new Oracle key", async () => {
    const root = await mountEditor("oracle");
    buttonWithText(root, "structureEditor.addColumn").click();
    await nextTick();

    const firstPrimaryKey = columnCheckbox(root, "structureEditor.primaryKey", 0);
    const secondPrimaryKey = columnCheckbox(root, "structureEditor.primaryKey", 1);
    expect(firstPrimaryKey.disabled).toBe(false);
    expect(secondPrimaryKey.disabled).toBe(false);

    firstPrimaryKey.checked = true;
    firstPrimaryKey.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(secondPrimaryKey.disabled).toBe(false);

    secondPrimaryKey.checked = true;
    secondPrimaryKey.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    await vi.waitFor(() =>
      expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
        expect.objectContaining({
          columns: [expect.objectContaining({ isPrimaryKey: true }), expect.objectContaining({ isPrimaryKey: true })],
        }),
      ),
    );
  });

  it("keeps an existing Oracle primary key and all replacement choices disabled", async () => {
    const root = await mountEditor("oracle", true);
    buttonWithText(root, "structureEditor.addColumn").click();
    await nextTick();

    expect(columnCheckbox(root, "structureEditor.primaryKey", 0).disabled).toBe(true);
    expect(columnCheckbox(root, "structureEditor.primaryKey", 1).disabled).toBe(true);
  });

  it.each(["oceanbase-oracle", "iris"] as const)("keeps primary-key creation disabled for existing %s tables", async (databaseType) => {
    const root = await mountEditor(databaseType);

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

describe("TableStructureEditor action column", () => {
  it("moves delayed shortcut hints onto the add, copy, and delete controls", async () => {
    const root = await mountEditor("dameng");

    expect(root.textContent).not.toContain("settings.shortcutsTab");
    expect(root.querySelector("[data-field-shortcut-hints]")).toBeNull();

    const addTooltip = root.querySelector<HTMLElement>("[data-add-column-shortcut-tooltip]");
    const copyTooltip = root.querySelector<HTMLElement>("[data-copy-column-shortcut-tooltip]");
    const deleteTooltip = root.querySelector<HTMLElement>("[data-delete-column-shortcut-tooltip]");
    expect(addTooltip?.getAttribute("delay-duration")).toBe("500");
    expect(copyTooltip?.getAttribute("delay-duration")).toBe("500");
    expect(deleteTooltip?.getAttribute("delay-duration")).toBe("500");
    expect(root.querySelector("[data-add-column-shortcut-content]")?.textContent).toBe("Shift+Enter");
    expect(root.querySelector("[data-copy-column-shortcut-content]")?.textContent).toBe("⌘/Ctrl+D");
    expect(root.querySelector("[data-delete-column-shortcut-content]")?.textContent?.trim()).toBe("⌘/Ctrl+Del");
    expect(root.querySelector("[data-add-column-shortcut-content]")?.textContent).not.toContain("structureEditor.addColumn");
    expect(root.querySelector("[data-copy-column-shortcut-content]")?.textContent).not.toContain("structureEditor.copyColumn");
    expect(copyTooltip?.querySelector("button")?.hasAttribute("title")).toBe(false);
    expect(deleteTooltip?.querySelector("button")?.hasAttribute("title")).toBe(false);
  });

  it("adds a field below the focused input on Shift+Enter", async () => {
    const root = await mountEditor("dameng");
    const sourceInput = root.querySelector<HTMLInputElement>('[data-column-row-index="0"] [data-column-name-input]');
    if (!sourceInput) throw new Error("Missing source column name input");

    sourceInput.focus();
    sourceInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }));

    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull());
    const addedInput = root.querySelector<HTMLInputElement>('[data-column-row-index="1"] [data-column-name-input]');
    expect(addedInput?.value).toBe("");
    expect(document.activeElement).toBe(addedInput);
  });

  it("copies the field below the focused input on Mod+D", async () => {
    const root = await mountEditor("dameng");
    const sourceInput = root.querySelector<HTMLInputElement>('[data-column-row-index="0"] [data-column-name-input]');
    if (!sourceInput) throw new Error("Missing source column name input");

    sourceInput.focus();
    sourceInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "d", ctrlKey: true }));

    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull());
    const copiedInput = root.querySelector<HTMLInputElement>('[data-column-row-index="1"] [data-column-name-input]');
    expect(copiedInput?.value).toBe(sourceInput.value);
    expect(document.activeElement).toBe(copiedInput);
  });

  it.each([
    { label: "Ctrl+Delete", event: { key: "Delete", ctrlKey: true } },
    { label: "Cmd+Delete", event: { key: "Backspace", metaKey: true } },
  ])("removes a focused unsaved field on $label", async ({ event }) => {
    const root = await mountEditor("dameng");
    buttonWithText(root, "structureEditor.addColumn").click();
    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull());
    const addedInput = root.querySelector<HTMLInputElement>('[data-column-row-index="1"] [data-column-name-input]');
    if (!addedInput) throw new Error("Missing added column name input");

    addedInput.focus();
    addedInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...event }));

    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).toBeNull());
    expect(root.querySelector('[data-column-row-index="0"]')).not.toBeNull();
  });

  it("marks a focused persisted field for deletion on Mod+Delete", async () => {
    const root = await mountEditor("dameng");
    const sourceInput = root.querySelector<HTMLInputElement>('[data-column-row-index="0"] [data-column-name-input]');
    if (!sourceInput) throw new Error("Missing source column name input");

    sourceInput.focus();
    sourceInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete", ctrlKey: true }));

    await vi.waitFor(() => expect(root.querySelector('button[aria-label="structureEditor.restore"]')).not.toBeNull());
  });

  it("keeps Ctrl+Backspace available for editing field text", async () => {
    const root = await mountEditor("dameng");
    buttonWithText(root, "structureEditor.addColumn").click();
    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull());
    const addedInput = root.querySelector<HTMLInputElement>('[data-column-row-index="1"] [data-column-name-input]');
    if (!addedInput) throw new Error("Missing added column name input");

    addedInput.focus();
    addedInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace", ctrlKey: true }));

    await nextTick();
    expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull();
  });

  it("keeps Cmd+Backspace available for editing non-empty field text", async () => {
    const root = await mountEditor("dameng");
    buttonWithText(root, "structureEditor.addColumn").click();
    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull());
    const addedInput = root.querySelector<HTMLInputElement>('[data-column-row-index="1"] [data-column-name-input]');
    if (!addedInput) throw new Error("Missing added column name input");

    addedInput.value = "name";
    addedInput.focus();
    addedInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace", metaKey: true }));

    await nextTick();
    expect(root.querySelector('[data-column-row-index="1"]')).not.toBeNull();
  });

  it("widens the ordinal indicator for a two-digit primary-key row", async () => {
    const root = await mountEditor("dameng");
    const addColumn = buttonWithText(root, "structureEditor.addColumn");
    for (let index = 0; index < 9; index += 1) {
      addColumn.click();
      await nextTick();
    }

    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey", 9);
    primaryKey.checked = true;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    const actionIndicator = root.querySelector<HTMLElement>('[data-column-row-index="9"] td:first-child > div > div:first-child');
    expect(Number.parseFloat(actionIndicator?.style.width ?? "0")).toBeGreaterThan(28);
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
  it("opens the initial DDL tab while loading only the table owner", async () => {
    await mountLoadingEditor("ddl");

    await vi.waitFor(() => expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(1));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1])).toEqual(["owner"]);
  });

  it.each([
    ["columns", ["columns", "indexes", "comment", "owner"]],
    ["indexes", ["columns", "indexes", "comment", "owner"]],
    ["foreignKeys", ["columns", "indexes", "foreign-keys", "comment", "owner"]],
    ["triggers", ["triggers", "comment", "owner"]],
  ] as const)("loads only the required facets for the initial %s tab", async (initialTab, expectedFacets) => {
    await mountLoadingEditor(initialTab);

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(expectedFacets.length));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1]).sort()).toEqual([...expectedFacets].sort());
    expect(mocks.loadObjectDdl).not.toHaveBeenCalled();
  });

  it("preserves exact PostgreSQL owner names and includes an owner change in the SQL preview", async () => {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({ value: facet === "owner" ? " app_user " : [], cacheStatus: "remote" }));
    mocks.executeQuery.mockResolvedValue({
      columns: ["user", "host", "plugin"],
      rows: [
        [" app_user ", "LOGIN", ""],
        ["reporting_role", "ROLE", ""],
      ],
    });
    mocks.buildTableOwnerChangeSql.mockImplementation(async (options: { owner: string; originalOwner: string }) => ({
      statements: options.owner === options.originalOwner ? [] : [`ALTER TABLE "public"."users" OWNER TO "${options.owner}";`],
      warnings: [],
    }));
    const root = await mountLoadingEditor("columns", " app_user ");

    const ownerSelect = await vi.waitFor(() => {
      const select = root.querySelector<HTMLButtonElement>("[data-owner-select]");
      expect(select?.dataset.modelValue).toBe(" app_user ");
      expect(JSON.parse(select?.dataset.options ?? "[]")).toEqual([" app_user ", "reporting_role"]);
      expect(select?.dataset.allowCustom).toBe("true");
      expect(select?.dataset.trimCustom).toBe("false");
      return select!;
    });
    ownerSelect.click();

    await vi.waitFor(() => expect(mocks.buildTableOwnerChangeSql).toHaveBeenLastCalledWith(expect.objectContaining({ owner: "custom_domain", originalOwner: " app_user ", schema: "public", tableName: "users" })));
  });

  it("loads the PostgreSQL primary index name before showing a missing-name warning", async () => {
    mocks.connection.db_type = "postgres";
    mocks.connection.name = "postgres";
    mocks.connection.driver_label = "postgres";
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.listDataTypes.mockResolvedValue([]);
    const warning = "Could not determine the existing PostgreSQL primary key constraint name. Refresh the table structure and try again.";
    mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [warning] });
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value:
        facet === "columns"
          ? [
              { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true },
              { name: "asdas", data_type: "integer", is_nullable: true, column_default: null, is_primary_key: false },
            ]
          : facet === "comment"
            ? ""
            : facet === "owner"
              ? "app_user"
              : [],
      cacheStatus: "remote",
    }));

    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "test",
      initialTab: "columns",
    });
    mountedApps.push(app);
    app.mount(root);

    await vi.waitFor(() => expect(root.querySelector('[data-column-row-index="0"]')).not.toBeNull());
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1]).sort()).toEqual(["columns", "indexes", "comment", "owner"].sort());

    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey");
    primaryKey.checked = false;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(root.textContent).toContain(warning));
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(true);
    expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(expect.objectContaining({ indexes: [] }));
  });

  it("backfills the PostgreSQL primary index name for a restored columns-only draft", async () => {
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
                name: "test_pk",
                columns: ["id"],
                is_unique: true,
                is_primary: true,
              },
            ]
          : facet === "comment"
            ? ""
            : facet === "owner"
              ? "app_user"
              : [],
      cacheStatus: "remote",
    }));

    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "test",
      draft: {
        ...draft(true),
        loadedMetadataFacets: ["columns", "comment"],
      },
    });
    mountedApps.push(app);
    app.mount(root);

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(2));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1]).sort()).toEqual(["indexes", "owner"]);

    const primaryKey = columnCheckbox(root, "structureEditor.primaryKey");
    primaryKey.checked = false;
    primaryKey.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() =>
      expect(mocks.buildTableStructureChangeSql).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indexes: [expect.objectContaining({ name: "test_pk", isPrimary: true, original: expect.objectContaining({ name: "test_pk", is_primary: true }) })],
        }),
      ),
    );
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
            : facet === "owner"
              ? "app_user"
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

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet).toHaveBeenCalledTimes(2));
    expect(mocks.loadObjectMetadataFacet.mock.calls.map((call) => call[1]).sort()).toEqual(["indexes", "owner"]);
    await vi.waitFor(() => expect(root.querySelector('[data-index-row-index="0"]')).not.toBeNull());
  });
});
