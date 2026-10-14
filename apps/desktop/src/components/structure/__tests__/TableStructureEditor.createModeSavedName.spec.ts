// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression: after creating a table the editor converts itself into the edit
// tab of the new table, so the emitted created name must be the name the
// server actually stored. The CREATE DDL emits plain Oracle identifiers
// unquoted (stored upper-folded) and plain Informix-family identifiers
// unquoted (stored lower-folded); dialects that quote new names keep the
// as-typed spelling. Emitting the as-typed name on a folding dialect left the
// converted edit tab querying a case that matches nothing.

const mocks = vi.hoisted(() => ({
  renderColumnRows: false,
  connection: {
    id: "structure-create-mode",
    name: "Oracle",
    db_type: "oracle",
    driver_label: "Oracle",
    database_info: { productVersion: "3.5.0" },
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  getColumns: vi.fn(),
  buildCopyTableDataSql: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildCreateTableSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Render rows without browser layout measurements so drag controls can be exercised.
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

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const Dialog = defineComponent({
    props: { open: Boolean },
    setup:
      (props, { slots }) =>
      () =>
        props.open ? h("div", slots.default?.()) : null,
  });
  return { Dialog, DialogContent: Div, DialogHeader: Div, DialogTitle: Div, DialogFooter: Div };
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
        (_props, { attrs }) =>
        () =>
          h("span", attrs),
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
  const TabsContent = defineComponent({
    name: "MockTabsContent",
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, mocks.renderColumnRows && attrs.value === "columns" ? slots.default?.() : undefined),
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup:
      (props, { attrs }) =>
      () =>
        h("button", { ...attrs, type: "button", "data-tab-trigger": props.value }),
  });
  return { Tabs: Div, TabsContent, TabsList: Div, TabsTrigger };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, mocks.renderColumnRows ? slots.default?.() : undefined),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Div, DropdownMenuTrigger: Div };
});
vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Popover: Div, PopoverContent: Div, PopoverTrigger: Div };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Tooltip: Div, TooltipContent: Div, TooltipTrigger: Div };
});
vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      name: "SearchableSelect",
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("button", { ...attrs, type: "button", "data-model-value": props.modelValue }),
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});
vi.mock("@/components/editor/EditorSearchPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "MockEditorSearchPanel",
      setup: () => ({ openSearch: () => false, closeSearch: () => false }),
      render: () => h("div", { "data-editor-search-panel": "true" }),
    }),
  };
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
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], fontSize: 13, fontFamily: "monospace", theme: "default", generateSqlQuoteIdentifiers: true },
    updateEditorSettings: mocks.updateEditorSettings,
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/sql/sqlFormatter", () => ({
  formatSqlForDisplay: vi.fn(async (sql: string) => sql),
  sqlFormatDialectForDbType: vi.fn(() => "mysql"),
}));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: vi.fn(async () => []), editorFontTheme: vi.fn(() => []) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeBatch: mocks.executeBatch,
  listDataTypes: mocks.listDataTypes,
  getColumns: mocks.getColumns,
  buildCopyTableDataSql: mocks.buildCopyTableDataSql,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildCreateTableSql: mocks.buildCreateTableSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
}));

import StarRocksLayoutCopyDialog from "@/components/structure/StarRocksLayoutCopyDialog.vue";
import StarRocksAlterLayoutEditor from "@/components/structure/StarRocksAlterLayoutEditor.vue";
import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";
import { emptyStarRocksPhysicalOptions } from "@/lib/table/starrocksPhysicalOptions";
import type { TableStructureEditorDraft } from "@/types/database";

const mountedApps: App[] = [];

async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

type SavedPayload = { commentChanged: boolean; createdTableName?: string };

/**
 * Mount the editor in create mode, run the generated CREATE batch to
 * completion, and return what the `saved` event carried — the exact string
 * the converted edit tab would be assigned as its table name.
 */
async function createTableAndCaptureSaved(dbType: string, newTableName: string): Promise<SavedPayload> {
  const previousDbType = mocks.connection.db_type;
  mocks.connection.db_type = dbType;
  let saved: SavedPayload | undefined;
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "columns",
        newTableName,
        tableComment: "",
        originalTableComment: "",
        columns: [{ id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false }],
        indexes: [],
        foreignKeys: [],
        triggers: [],
        initialized: true,
      },
      onSaved: (commentChanged: boolean, createdName?: string) => {
        saved = { commentChanged, createdTableName: createdName };
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };

    // The SQL preview is debounced (300ms), and a hydrated draft schedules a
    // second refresh on mount; poll the apply entry point — its guard returns
    // false without side effects while the preview is still pending.
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled(), { timeout: 3000 });
    await vi.waitFor(
      async () => {
        const applied = await editor.applyChanges();
        expect(applied).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(mocks.executeBatch).toHaveBeenCalled();
    await settle();
  } finally {
    mocks.connection.db_type = previousDbType;
  }
  expect(saved).toBeDefined();
  return saved!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderColumnRows = false;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false, isForeign: false });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE MyTable (id number)"], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE MyTable (id number)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({
    value: facet === "comment" ? "" : [],
    cacheStatus: "remote",
  }));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor created-table name write-back", () => {
  it("emits the upper-folded storage name for a plain Oracle table", async () => {
    const saved = await createTableAndCaptureSaved("oracle", "MyTable");
    expect(saved.createdTableName).toBe("MYTABLE");
  });

  it("emits the lower-folded storage name for a plain Informix-family table", async () => {
    const saved = await createTableAndCaptureSaved("informix", "MyTable");
    expect(saved.createdTableName).toBe("mytable");
  });

  it("emits the as-typed name unchanged on dialects that quote new identifiers", async () => {
    const postgres = await createTableAndCaptureSaved("postgres", "MyTable");
    expect(postgres.createdTableName).toBe("MyTable");

    const mysql = await createTableAndCaptureSaved("mysql", "MyTable");
    expect(mysql.createdTableName).toBe("MyTable");
  });

  it("keeps a quoting-required Oracle name exactly as typed", async () => {
    const saved = await createTableAndCaptureSaved("oracle", "my table");
    expect(saved.createdTableName).toBe("my table");
  });
});

describe("StarRocks create layout integration", () => {
  it("restores layout drafts, sends dialect options, and persists bucket and sort priority edits", async () => {
    const previousType = mocks.connection.db_type;
    mocks.connection.db_type = "starrocks";
    try {
      const root = document.createElement("div");
      document.body.append(root);
      let latestDraft: TableStructureEditorDraft | undefined;
      const app = createApp(TableStructureEditor, {
        connectionId: mocks.connection.id,
        database: "test",
        tableName: "",
        draft: {
          dirty: true,
          activeTab: "columns",
          newTableName: "events",
          tableComment: "",
          originalTableComment: "",
          columns: [
            { id: "id", name: "id", dataType: "bigint", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
            { id: "ts", name: "event_time", dataType: "datetime", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
          ],
          indexes: [],
          foreignKeys: [],
          triggers: [],
          initialized: true,
          starrocksPhysicalOptions: { ...emptyStarRocksPhysicalOptions(), partitionKind: "time", partitionColumnId: "ts", bucketCount: "8", sortColumnIds: ["ts", "id"] },
        },
        "onUpdate:draft": (draft) => {
          latestDraft = draft;
        },
      });
      mountedApps.push(app);
      app.mount(root);
      await vi.waitFor(() =>
        expect(mocks.buildCreateTableSql).toHaveBeenCalledWith(
          expect.objectContaining({ tableName: "events", databaseType: "starrocks" }),
          "3.5.0",
          expect.objectContaining({ starrocks: expect.objectContaining({ timePartition: expect.objectContaining({ columnId: "ts", granularity: "month" }), bucketCount: 8, sortColumnIds: ["ts", "id"] }) }),
        ),
      );
      const panel = root.querySelector("[data-starrocks-physical-options]");
      expect(panel).not.toBeNull();
      const sortPanel = panel!.querySelector("[data-starrocks-sort]")!;
      const moveDown = sortPanel.querySelector<HTMLButtonElement>('button[aria-label="starrocksLayout.moveSortDown"]')!;
      moveDown.click();
      await vi.waitFor(() => expect(latestDraft?.starrocksPhysicalOptions?.sortColumnIds).toEqual(["id", "ts"]));
      await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenLastCalledWith(expect.anything(), "3.5.0", expect.objectContaining({ starrocks: expect.objectContaining({ sortColumnIds: ["id", "ts"] }) })));
      const bucketInput = panel!.querySelector<HTMLInputElement>("[data-starrocks-buckets] input[type=number]")!;
      bucketInput.value = "12";
      bucketInput.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(latestDraft?.starrocksPhysicalOptions?.bucketCount).toBe("12"));
      await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenLastCalledWith(expect.anything(), "3.5.0", expect.objectContaining({ starrocks: expect.objectContaining({ bucketCount: 12 }) })));
    } finally {
      mocks.connection.db_type = previousType;
    }
  });
});

describe("StarRocks existing-table layout", () => {
  it("replaces inline ALTER controls with an independent create-and-transfer dialog", async () => {
    const previousType = mocks.connection.db_type;
    mocks.connection.db_type = "starrocks";
    mocks.loadObjectDdl.mockResolvedValue({ ddl: 'CREATE TABLE `events` (`id` bigint NOT NULL) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM PROPERTIES("bucket_size"="1073741824")', cacheStatus: "remote" });
    mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "bigint", is_nullable: false, is_primary_key: false }]);
    mocks.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE `events_layout` (`id` bigint NOT NULL) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM"], warnings: [] });
    mocks.buildCopyTableDataSql.mockResolvedValue("INSERT INTO `test`.`events_layout` (`id`) SELECT `id` FROM `test`.`events`;");
    try {
      const root = document.createElement("div");
      document.body.append(root);
      const app = createApp(TableStructureEditor, {
        connectionId: mocks.connection.id,
        database: "test",
        tableName: "events",
        initialTab: "columns",
        draft: {
          dirty: false,
          activeTab: "columns",
          newTableName: "events",
          tableComment: "",
          originalTableComment: "",
          columns: [{ id: "id", name: "id", dataType: "bigint", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false, original: { name: "id", data_type: "bigint", is_nullable: false, is_primary_key: false } }],
          indexes: [],
          foreignKeys: [],
          triggers: [],
          initialized: true,
        },
      });
      mountedApps.push(app);
      app.mount(root);
      await settle();
      expect(root.querySelector("[data-starrocks-alter-layout]")).toBeNull();
      await vi.waitFor(() => expect(root.querySelector("[data-starrocks-layout-copy-button]")).not.toBeNull());
      const button = root.querySelector<HTMLButtonElement>("[data-starrocks-layout-copy-button]")!;
      button.click();
      await vi.waitFor(() => expect(root.querySelector("[data-starrocks-layout-copy-dialog] pre")?.textContent).toContain("CREATE TABLE"));
      const dialog = root.querySelector("[data-starrocks-layout-copy-dialog]")!;
      const checkboxes = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checkboxes[0]!.checked).toBe(false);
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      checkboxes[0]!.click();
      await vi.waitFor(() => expect(dialog.querySelector("details:last-child pre")?.textContent).toContain("SET_VAR(enable_insert_strict=true)"));
      const create = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "starrocksLayout.copyExecute")!;
      expect(create.disabled).toBe(false);
      create.click();
      await vi.waitFor(() => expect(mocks.executeBatch).toHaveBeenCalledTimes(2));
      expect(mocks.executeBatch.mock.calls[0]![2][0]).toContain("CREATE TABLE `test`.`events_layout`");
      expect(mocks.executeBatch.mock.calls[1]![2][0]).toContain("INSERT /*+ SET_VAR(enable_insert_strict=true) */");
      await vi.waitFor(() => expect(create.disabled).toBe(true));
      create.click();
      await settle();
      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
    } finally {
      mocks.connection.db_type = previousType;
    }
  });
});

it("locks automatic-scaling distribution while retaining partition controls", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(StarRocksAlterLayoutEditor, {
    modelValue: { method: "random", columns: [], bucketCount: "", defaultOnly: false, partitions: [] },
    context: { serverVersion: "3.5.0", model: "duplicate", keyColumns: [], partitionColumns: [], distributionColumns: [], automaticBucketScaling: true },
    columns: [],
  });
  mountedApps.push(app);
  app.mount(root);
  await settle();
  const numbers = root.querySelectorAll<HTMLInputElement>('input[type="number"]');
  expect(numbers[0]!.disabled).toBe(true);
  expect(numbers[1]!.disabled).toBe(false);
  expect(root.textContent).toContain("starrocksLayout.automaticBucketsReadonly");
});

describe("StarRocks layout copy execution", () => {
  it.each(["empty", "createFailure", "transferFailure"])("handles %s without replaying creation or data", async (scenario) => {
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE `source` (`id` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM", cacheStatus: "remote" });
    mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "int", is_nullable: true, is_primary_key: false }]);
    mocks.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE `new` (`id` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM"], warnings: [] });
    mocks.buildCopyTableDataSql.mockResolvedValue("INSERT INTO `test`.`source_layout` (`id`) SELECT `id` FROM `test`.`source`;");
    if (scenario === "createFailure") mocks.executeBatch.mockRejectedValueOnce(new Error("already exists"));
    if (scenario === "transferFailure") mocks.executeBatch.mockResolvedValueOnce({ rowsAffected: 0 }).mockRejectedValueOnce(new Error("load failed"));
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(StarRocksLayoutCopyDialog, { open: true, connectionId: "c", database: "test", tableName: "source", serverVersion: "3.5.0", authorize: async () => true });
    mountedApps.push(app);
    app.mount(root);
    const execute = () => [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "starrocksLayout.copyExecute");
    await vi.waitFor(() => expect(execute()?.disabled).toBe(false));
    if (scenario !== "empty") {
      root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      await vi.waitFor(() => expect(root.textContent).toContain("SET_VAR(enable_insert_strict=true)"));
    }
    execute()!.click();
    if (scenario === "empty") {
      await vi.waitFor(() => expect(root.textContent).toContain("starrocksLayout.copyStage_complete"));
      expect(mocks.executeBatch).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe(`starrocksLayout.copy${scenario === "createFailure" ? "Create" : "Transfer"}Failed`));
      expect(mocks.executeBatch).toHaveBeenCalledTimes(scenario === "createFailure" ? 1 : 2);
    }
    expect(execute()?.disabled).toBe(true);
    execute()!.click();
    await settle();
    expect(mocks.executeBatch).toHaveBeenCalledTimes(scenario === "transferFailure" ? 2 : 1);
  });
});

it("routes a restored StarRocks column order through the physical ALTER interface", async () => {
  const previousType = mocks.connection.db_type;
  mocks.connection.db_type = "starrocks";
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE `t` (`id` INT, `first` INT, `last` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM", cacheStatus: "remote" });
  const makeColumn = (name: string, index: number) => ({
    id: `existing:${name}`,
    name,
    dataType: "int",
    isNullable: false,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    extra: {},
    markedForDrop: false,
    originalPosition: index,
    original: { name, data_type: "int", is_nullable: false, is_primary_key: false },
  });
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "t",
      draft: { dirty: true, activeTab: "columns", newTableName: "t", tableComment: "", originalTableComment: "", columns: [makeColumn("id", 0), makeColumn("last", 2), makeColumn("first", 1)], indexes: [], foreignKeys: [], triggers: [], initialized: true },
    });
    mountedApps.push(app);
    app.mount(root);
    await vi.waitFor(() =>
      expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledWith(
        expect.objectContaining({ columns: [expect.objectContaining({ name: "id" }), expect.objectContaining({ name: "last" }), expect.objectContaining({ name: "first" })] }),
        expect.objectContaining({ model: "duplicate", columnNames: ["id", "first", "last"], reorderColumns: false, positionColumnOrder: true }),
      ),
    );
    expect(root.textContent).toContain("starrocksLayout.reorderHint");
  } finally {
    mocks.connection.db_type = previousType;
  }
});

it.each(["beforeDay", "afterName", "valueFirst", "valueBetweenKeys"])("allows key swaps but rejects crossing the StarRocks key/value boundary: %s", async (placement) => {
  mocks.renderColumnRows = true;
  const previousType = mocks.connection.db_type;
  mocks.connection.db_type = "starrocks";
  const metadata = ["day", "id", "name"].map((name) => ({ name, data_type: "int", is_nullable: false, is_primary_key: false }));
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE `t` (`day` INT, `id` INT, `name` INT) ENGINE=OLAP DUPLICATE KEY(`day`, `id`) PARTITION BY (time_slice(`day`, INTERVAL 7 year, floor), `id`) DISTRIBUTED BY RANDOM ORDER BY (`id`, `day`)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({ value: facet === "columns" ? metadata : facet === "comment" ? "" : [], cacheStatus: "remote" }));
  let latestDraft: TableStructureEditorDraft | undefined;
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "t",
      initialTab: "columns",
      "onUpdate:draft": (draft) => {
        latestDraft = draft;
      },
    });
    mountedApps.push(app);
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelectorAll('[aria-label="structureEditor.dragColumn"]')).toHaveLength(3));
    await settle();
    const handles = root.querySelectorAll<HTMLButtonElement>('[aria-label="structureEditor.dragColumn"]');
    expect(handles[0]!.disabled).toBe(false);
    expect(handles[1]!.disabled).toBe(false);
    const sourceIndex = placement.startsWith("value") ? 2 : 1;
    handles[sourceIndex]!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    const targetIndex = placement === "afterName" ? 2 : 0;
    root.querySelector(`[data-column-row-index="${targetIndex}"]`)!.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: placement === "beforeDay" || placement === "valueFirst" ? -1 : 1 }));
    const expected = placement === "beforeDay" ? ["id", "day", "name"] : ["day", "id", "name"];
    await vi.waitFor(() => expect(latestDraft?.columns?.map((column) => column.name)).toEqual(expected));
    if (placement !== "beforeDay") {
      expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() =>
      expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledWith(
        expect.objectContaining({ columns: expected.map((name) => expect.objectContaining({ name })) }),
        expect.objectContaining({ model: "duplicate", keyColumns: ["day", "id"], partitionColumns: ["day", "id"], partitionExpressionColumns: ["day"], positionColumnOrder: true }),
      ),
    );
    expect(latestDraft?.starrocksSortColumns).toEqual(["id", "day"]);
  } finally {
    mocks.connection.db_type = previousType;
  }
});

it("hydrates and persists edited sort-key priority independently of column order", async () => {
  const previousType = mocks.connection.db_type;
  mocks.connection.db_type = "starrocks";
  const metadata = ["id", "first", "last"].map((name) => ({ name, data_type: "int", is_nullable: false, is_primary_key: false }));
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE `t` (`id` INT, `first` INT, `last` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM ORDER BY(`id`, `last`)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({ value: facet === "columns" ? metadata : facet === "comment" ? "" : [], cacheStatus: "remote" }));
  let latestDraft: TableStructureEditorDraft | undefined;
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "t",
      initialTab: "columns",
      "onUpdate:draft": (draft) => {
        latestDraft = draft;
      },
    });
    mountedApps.push(app);
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector("[data-starrocks-edit-sort] li")?.textContent).toContain("id"));
    expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();
    const panel = root.querySelector("[data-starrocks-edit-sort]")!;
    panel.querySelector<HTMLButtonElement>('[aria-label="starrocksLayout.moveSortDown"]')!.click();
    await vi.waitFor(() => expect(latestDraft?.starrocksSortColumns).toEqual(["last", "id"]));
    await vi.waitFor(() =>
      expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledWith(
        expect.objectContaining({ columns: [expect.objectContaining({ name: "id" }), expect.objectContaining({ name: "first" }), expect.objectContaining({ name: "last" })] }),
        expect.objectContaining({ sortColumns: ["id", "last"], sortColumnNames: ["last", "id"], reorderColumns: false }),
      ),
    );
  } finally {
    mocks.connection.db_type = previousType;
  }
});

it.each([false, true])("refreshes finished StarRocks jobs only without a draft (dirty=%s)", async (dirty) => {
  const previousType = mocks.connection.db_type;
  mocks.connection.db_type = "starrocks";
  const metadata = ["id", "name"].map((name) => ({ name, data_type: "int", is_nullable: false, is_primary_key: false }));
  const ddl = "CREATE TABLE `t` (`id` INT, `name` INT) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM";
  mocks.loadObjectDdl.mockResolvedValue({ ddl, cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({ value: facet === "columns" ? metadata : facet === "comment" ? "" : [], cacheStatus: "remote" }));
  mocks.getColumns.mockResolvedValue(metadata);
  let state = "RUNNING";
  mocks.executeQuery.mockImplementation(async (_c, _d, sql) => ({ columns: ["JobId", "State", "CreateTime"], rows: sql.includes(" COLUMN ") ? [[1, state, "2026-01-01"]] : [] }));
  const makeColumn = (name: string, index: number) => ({ id: `existing:${name}`, name, dataType: "int", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false, originalPosition: index, original: metadata[index] });
  let latestDraft: TableStructureEditorDraft | undefined;
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "t",
      initialTab: "columns",
      ...(dirty ? { draft: { dirty: true, activeTab: "columns" as const, newTableName: "t", tableComment: "", originalTableComment: "", columns: [makeColumn("id", 0), { ...makeColumn("name", 1), name: "draft_name" }], indexes: [], foreignKeys: [], triggers: [], initialized: true } } : {}),
      "onUpdate:draft": (draft) => {
        latestDraft = draft;
      },
    });
    mountedApps.push(app);
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector("[data-starrocks-alter-status]")?.textContent).toContain("starrocksStatus.RUNNING"));
    await settle();
    mocks.getColumns.mockClear();
    state = "FINISHED";
    const refresh = [...root.querySelectorAll<HTMLButtonElement>("[data-starrocks-alter-status] button")].find((button) => button.textContent === "starrocksStatus.refresh")!;
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector("[data-starrocks-alter-status]")?.textContent).toContain("starrocksStatus.idle"));
    await settle();
    if (dirty) {
      expect(mocks.getColumns).not.toHaveBeenCalled();
      expect(latestDraft?.columns?.[1]?.name).toBe("draft_name");
    } else {
      await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalled());
      expect(latestDraft?.columns?.[1]?.name).toBe("name");
    }
  } finally {
    mocks.connection.db_type = previousType;
  }
});

it.each(["existing", "added", "create"].flatMap((mode) => ["decimal(7,0)", "varchar(255)"].map((dataType) => ({ mode, dataType }))))("keeps StarRocks defaults valid for $mode $dataType", async ({ mode, dataType }) => {
  mocks.renderColumnRows = true;
  const previousType = mocks.connection.db_type;
  mocks.connection.db_type = "starrocks";
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE `t` (`id` INT, `price` DECIMAL(7,0)) ENGINE=OLAP DUPLICATE KEY(`id`) DISTRIBUTED BY RANDOM", cacheStatus: "remote" });
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: mode === "create" ? "" : "t",
      draft: {
        dirty: true,
        activeTab: "columns",
        newTableName: "t",
        tableComment: "",
        originalTableComment: "",
        columns: [
          {
            id: "price",
            name: "price",
            dataType,
            isNullable: true,
            defaultValue: "'0'",
            comment: "",
            isPrimaryKey: false,
            extra: {},
            markedForDrop: false,
            original: mode === "existing" ? { name: "price", data_type: dataType, is_nullable: true, is_primary_key: false, column_default: "'0'" } : undefined,
          },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
        initialized: true,
      },
    });
    mountedApps.push(app);
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector(".structure-column-default-value input")).not.toBeNull());
    await settle();
    const input = root.querySelector<HTMLInputElement>(".structure-column-default-value input")!;
    const presets = root.querySelector<HTMLButtonElement>('button[aria-label="structureEditor.defaultValuePresets"]')!;
    expect(input.value).toBe("'0'");
    expect(input.disabled).toBe(mode === "existing");
    expect(presets.disabled).toBe(mode === "existing");
    const expected = dataType.startsWith("decimal") ? ["'0'", "'1'"] : mode === "create" ? ["''", "(uuid())"] : ["''"];
    expect(Array.from(root.querySelectorAll(".structure-column-default-value code"), (node) => node.textContent)).toEqual(["structureEditor.unsetDefault", "NULL", ...expected]);
  } finally {
    mocks.connection.db_type = previousType;
  }
});
