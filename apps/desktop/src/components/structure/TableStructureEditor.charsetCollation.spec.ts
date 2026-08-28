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
  getMysqlTableAutoIncrement: mocks.getMysqlTableAutoIncrement,
  executeBatch: mocks.executeBatch,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];
let mountedEditor: { applyChanges: () => Promise<boolean> } | undefined;

function draft(autoIncrement = false, counter?: { value?: string; originalValue?: string }) {
  return {
    initialized: true,
    activeTab: "columns" as const,
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    mysqlAutoIncrementValue: counter?.value,
    originalMysqlAutoIncrementValue: counter?.originalValue,
    columns: [
      {
        id: "existing:id",
        name: "id",
        dataType: "VARCHAR",
        isNullable: true,
        defaultValue: "",
        comment: "",
        isPrimaryKey: false,
        characterSet: "utf8mb3",
        collation: "utf8mb3_uca1400_ai_ci",
        extra: { autoIncrement },
        original: {
          name: "id",
          data_type: "VARCHAR",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: autoIncrement ? "auto_increment" : null,
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

async function mountEditor(autoIncrement = false, counter?: { value?: string; originalValue?: string }, draftOverride?: ReturnType<typeof draft>) {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "test",
    tableName: "users",
    draft: draftOverride ?? draft(autoIncrement, counter),
  });
  mountedApps.push(app);
  mountedEditor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

function searchableSelectInColumn(root: HTMLElement, header: string): HTMLButtonElement {
  const headerIndex = Array.from(root.querySelectorAll("thead th")).findIndex((cell) => cell.textContent?.trim() === header);
  if (headerIndex < 0) throw new Error(`Missing ${header} column`);
  const row = root.querySelector<HTMLElement>('[data-column-row-index="0"]');
  const cell = row?.querySelectorAll("td")[headerIndex];
  const select = cell?.querySelector<HTMLButtonElement>('[data-searchable-select="true"]');
  if (!select) throw new Error(`Missing ${header} searchable select`);
  return select;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.db_type = "mysql";
  mocks.connection.name = "MySQL";
  mocks.connection.driver_label = "MySQL";
  mocks.connection.driver_profile = "mysql";
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id varchar(255))", cacheStatus: "remote" });
  mocks.invalidateObjectDdl.mockResolvedValue(undefined);
  mocks.loadObjectMetadataFacet.mockResolvedValue({ value: [], cacheStatus: "remote" });
  mocks.getMysqlTableAutoIncrement.mockResolvedValue("10");
  mocks.buildMysqlAutoIncrementSql.mockImplementation(async ({ value }: { value: string }) => `ALTER TABLE \`test\`.\`users\` AUTO_INCREMENT = ${value};`);
  mocks.executeBatch.mockResolvedValue({ affected_rows: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor charset/collation column width", () => {
  it("lets the charset trigger fill its resizable column instead of a fixed width cap", async () => {
    const root = await mountEditor();
    const charsetSelect = searchableSelectInColumn(root, "structureEditor.characterSet");

    const triggerClass = charsetSelect.getAttribute("trigger-class") ?? "";
    expect(triggerClass.split(",")).toContain("w-full");
    expect(triggerClass.split(",")).not.toEqual(expect.arrayContaining(["w-20"]));
  });

  it("lets the collation trigger fill its resizable column instead of a fixed width cap", async () => {
    const root = await mountEditor();
    const collationSelect = searchableSelectInColumn(root, "structureEditor.collation");

    const triggerClass = collationSelect.getAttribute("trigger-class") ?? "";
    expect(triggerClass.split(",")).toContain("w-full");
    expect(triggerClass.split(",")).not.toEqual(expect.arrayContaining(["w-28"]));
  });
});

describe("TableStructureEditor MySQL AUTO_INCREMENT counter", () => {
  it("loads and renders the server value as a decimal string only for an existing auto-increment column", async () => {
    const root = await mountEditor(true);
    await vi.waitFor(() => expect(mocks.getMysqlTableAutoIncrement).toHaveBeenCalledWith("structure-charset-test", "test", "users"));

    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]");
    expect(input?.value).toBe("10");
    expect(input?.disabled).toBe(false);
    expect(input?.classList.contains("structure-grid-control")).toBe(false);
    expect(input?.classList.contains("font-mono")).toBe(true);
    expect(input?.closest("td")).not.toBeNull();
    expect(root.querySelector("[data-mysql-auto-increment-editor-trigger]")?.getAttribute("title")).toContain("structureEditor.editMysqlAutoIncrementValue");
  });

  it("loads an editable blank counter when auto-increment is checked before saving", async () => {
    mocks.getMysqlTableAutoIncrement.mockResolvedValueOnce(null);
    const root = await mountEditor(false);
    expect(root.querySelector("[data-mysql-auto-increment-editor-trigger]")).toBeNull();

    const autoIncrementLabel = Array.from(root.querySelectorAll("label")).find((label) => label.textContent?.includes("structureEditor.autoIncrement"));
    const checkbox = autoIncrementLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.getMysqlTableAutoIncrement).toHaveBeenCalledWith("structure-charset-test", "test", "users"));
    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]");
    await vi.waitFor(() => expect(input?.disabled).toBe(false));
    expect(input?.value).toBe("");
  });

  it("keeps a restored dirty blank-counter draft when the server has no counter", async () => {
    mocks.getMysqlTableAutoIncrement.mockResolvedValueOnce(null);
    const restoredDraft = draft(false, { value: "500", originalValue: "" });
    restoredDraft.columns[0].extra.autoIncrement = true;
    const root = await mountEditor(false, undefined, restoredDraft);

    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]");
    await vi.waitFor(() => expect(input?.value).toBe("500"));
  });

  it("accepts unsigned bigint digits and rejects non-decimal input without rewriting it", async () => {
    const root = await mountEditor(true);
    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")!;
    await vi.waitFor(() => expect(input.value).toBe("10"));
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("pattern")).toBe("[0-9]*");

    const maxUnsignedBigint = "18446744073709551615";
    input.value = maxUnsignedBigint;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledWith(expect.objectContaining({ value: maxUnsignedBigint })));
    mocks.buildMysqlAutoIncrementSql.mockClear();

    for (const invalidValue of ["abc", "-1", "+1", "1.5", "1e3"]) {
      input.value = invalidValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.value).toBe(maxUnsignedBigint);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();
  });

  it("refreshes a restored clean counter draft from the server", async () => {
    mocks.getMysqlTableAutoIncrement.mockResolvedValueOnce("30");
    const root = await mountEditor(true, { value: "10", originalValue: "10" });

    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.value).toBe("30"));
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();
  });

  it("keeps a restored dirty value while rebasing its server baseline", async () => {
    mocks.getMysqlTableAutoIncrement.mockResolvedValueOnce("15");
    const root = await mountEditor(true, { value: "20", originalValue: "10" });
    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")!;

    await vi.waitFor(() => expect(input.value).toBe("20"));
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledWith(expect.objectContaining({ value: "20" })));
    mocks.buildMysqlAutoIncrementSql.mockClear();
    input.value = "15";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();
  });

  it("keeps NULL or failed optional metadata from enabling a counter edit", async () => {
    mocks.getMysqlTableAutoIncrement.mockResolvedValueOnce(null);
    const nullRoot = await mountEditor(true);
    await vi.waitFor(() => expect(mocks.getMysqlTableAutoIncrement).toHaveBeenCalled());
    expect(nullRoot.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.disabled).toBe(true);

    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    mocks.getMysqlTableAutoIncrement.mockRejectedValueOnce(new Error("permission denied"));
    const errorRoot = await mountEditor(true);
    await vi.waitFor(() => expect(errorRoot.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.title).toBe("permission denied"));
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();

    const structureStatement = "ALTER TABLE `test`.`users` COMMENT = 'ordinary edit';";
    mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [structureStatement], warnings: [] });
    const commentInput = Array.from(errorRoot.querySelectorAll<HTMLInputElement>("input")).find((input) => !input.hasAttribute("data-mysql-auto-increment-counter"))!;
    commentInput.value = "ordinary edit";
    commentInput.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled());
    await vi.waitFor(() => expect(Array.from(errorRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("structureEditor.apply"))?.disabled).toBe(false));
    await expect(mountedEditor?.applyChanges()).resolves.toBe(true);
    expect(mocks.executeBatch.mock.calls[mocks.executeBatch.mock.calls.length - 1]?.[2]).toEqual([structureStatement]);
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();
  });

  it("appends validated counter DDL and preserves the draft when execution fails", async () => {
    const root = await mountEditor(true);
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.value).toBe("10"));
    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")!;
    input.value = "9007199254740993";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledWith(expect.objectContaining({ value: "9007199254740993" })));

    mocks.executeBatch.mockRejectedValueOnce(new Error("ALTER command denied"));
    await expect(mountedEditor?.applyChanges()).resolves.toBe(false);
    await vi.waitFor(() => expect(root.textContent).toContain("ALTER command denied"));
    expect(input.value).toBe("9007199254740993");
  });

  it("does not treat the requested value as persisted when the post-save metadata refresh fails", async () => {
    const persistedColumn = draft(true).columns[0]!.original;
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value: facet === "columns" ? [persistedColumn] : [],
      cacheStatus: "remote",
    }));
    const root = await mountEditor(true);
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.value).toBe("10"));
    const input = root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")!;
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledWith(expect.objectContaining({ value: "20" })));
    const metadataCallsBeforeSave = mocks.getMysqlTableAutoIncrement.mock.calls.length;
    mocks.getMysqlTableAutoIncrement.mockRejectedValueOnce(new Error("refresh denied"));
    mocks.buildMysqlAutoIncrementSql.mockClear();

    await expect(mountedEditor?.applyChanges()).resolves.toBe(true);
    await vi.waitFor(() => expect(mocks.getMysqlTableAutoIncrement.mock.calls.length).toBeGreaterThan(metadataCallsBeforeSave));
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.title).toBe("refresh denied"));
    expect(root.querySelector<HTMLInputElement>("[data-mysql-auto-increment-counter]")?.value).toBe("20");
    expect(mocks.buildMysqlAutoIncrementSql).not.toHaveBeenCalled();
  });
});
