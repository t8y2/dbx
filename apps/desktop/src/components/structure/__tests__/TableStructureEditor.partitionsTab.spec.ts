// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TABLE_DDL = "CREATE TABLE `users` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `email` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-partitions-tab",
    name: "PostgreSQL",
    db_type: "postgres",
    driver_label: "PostgreSQL",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildTablePartitionOperationSql: vi.fn(),
  buildCreatePartitionedTableSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTablePartitioning: vi.fn(),
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
// Tabs mock that reproduces the one detail this regression depends on: reka-ui's
// TabsContent renders its slot through Presence, and `usePresence` awaits a
// `nextTick` before dispatching MOUNT. So the pane (and every template ref
// inside it) mounts one tick *after* the tab became active. A mock that renders
// panes unconditionally — like the other structure specs use — cannot see the
// bug at all.
vi.mock("@/components/ui/tabs", async () => {
  const { computed, defineComponent, h, inject, nextTick, provide, ref, watch } = await import("vue");
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
      const selected = computed(() => active.value === props.value);
      const present = ref(selected.value);
      watch(selected, async (isSelected) => {
        if (!isSelected) {
          present.value = false;
          return;
        }
        await nextTick();
        present.value = true;
      });
      return () => h("div", attrs, present.value ? slots.default?.() : undefined);
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
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs, slots }) =>
      () =>
        h("div", attrs, slots.default?.()),
  });
  const Dialog = defineComponent({
    name: "MockDialog",
    props: { open: { type: Boolean, default: false } },
    emits: ["update:open"],
    setup:
      (props, { slots }) =>
      () =>
        props.open ? h("div", { "data-dialog": "open" }, slots.default?.()) : null,
  });
  return { Dialog, DialogContent: Div, DialogFooter: Div, DialogHeader: Div, DialogTitle: Div };
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
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTablePartitioning: mocks.getTablePartitioning,
  buildTablePartitionOperationSql: mocks.buildTablePartitionOperationSql,
  buildCreatePartitionedTableSql: mocks.buildCreatePartitionedTableSql,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

function structureDraft(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dirty: false,
    activeTab: "partitions",
    newTableName: "",
    tableComment: "",
    originalTableComment: "",
    columns: [],
    indexes: [],
    foreignKeys: [],
    constraints: [],
    triggers: [],
    initialized: true,
    ...overrides,
  };
}

async function mountStructureEditor(props: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    tableName: "users",
    ...props,
  });
  mountedApps.push(app);
  app.mount(root);
  await vi.waitFor(
    () => {
      expect(root.querySelector('[data-tab-trigger="foreignKeys"]')).not.toBeNull();
      expect(root.textContent).toContain("structureEditor.noChanges");
    },
    { timeout: 3000 },
  );
  await settle();
  return root;
}

/** Let every already-queued load/preview microtask land before touching the DOM. */
async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing ${text} button`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: true, isPartition: false });
  mocks.buildTablePartitionOperationSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildCreatePartitionedTableSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.getTablePartitioning.mockResolvedValue({
    isPartitioned: true,
    isPartition: false,
    strategy: "range",
    keyDefinition: "RANGE (sold_on)",
    keyColumns: ["sold_on"],
    defaultPartition: "sales_default",
    partitions: [
      { schema: "public", name: "sales_2024", isLeaf: true, bound: { kind: "range", from: ["'2024-01-01'"], to: ["'2025-01-01'"] }, children: [] },
      { schema: "public", name: "sales_default", isLeaf: true, bound: { kind: "default" }, children: [] },
    ],
  });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: TABLE_DDL, cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({
    value:
      facet === "comment"
        ? ""
        : facet === "columns"
          ? [
              { name: "id", data_type: "bigint", nullable: false, default_value: null, comment: "" },
              { name: "email", data_type: "varchar(255)", nullable: true, default_value: null, comment: "" },
            ]
          : [],
    cacheStatus: "remote",
  }));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor partitions tab", () => {
  it("renders the Partitions tab for PostgreSQL and loads the partition tree on activation", async () => {
    const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });

    expect(root.querySelector('[data-tab-trigger="partitions"]')).not.toBeNull();
    await settle();
    expect(mocks.getTablePartitioning).toHaveBeenCalledWith(mocks.connection.id, "test", "", "users");

    const text = root.textContent ?? "";
    expect(text).toContain("structureEditor.partitionKindRange");
    expect(text).toContain("sales_2024");
    expect(text).toContain("sales_default");
    expect(text).toContain("structureEditor.partitionsDefault");
  });

  it("shows the empty state for a table that is not partitioned", async () => {
    mocks.getTablePartitioning.mockResolvedValue({ isPartitioned: false, isPartition: false, keyColumns: [], partitions: [] });
    const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });

    await settle();
    expect(root.textContent ?? "").toContain("structureEditor.partitionsEmpty");
  });

  it("submits pending partition operations through the dedicated builder", async () => {
    const operation = {
      id: "op:1",
      kind: "create",
      parentSchema: "",
      parentTable: "",
      schema: "",
      name: "sales_2025",
      bound: { kind: "default" },
      concurrently: false,
    };
    mocks.buildTablePartitionOperationSql.mockResolvedValue({
      statements: ['CREATE TABLE "public"."sales_2025" PARTITION OF "public"."sales" DEFAULT;'],
      warnings: [],
    });

    const root = await mountStructureEditor({
      initialTab: "partitions",
      initialTabRequestId: 1,
      draft: structureDraft({ activeTab: "partitions", partitionOperations: [operation] }),
    });
    await settle();
    // The SQL preview is debounced, so wait for the builder rather than assuming
    // it ran within the microtask settle loop.
    await vi.waitFor(() => expect(mocks.buildTablePartitionOperationSql).toHaveBeenCalled(), { timeout: 3000 });
    await settle();

    const options = mocks.buildTablePartitionOperationSql.mock.calls.at(-1)?.[0] as { operations: unknown[] };
    expect(options.operations).toHaveLength(1);
    expect(root.textContent ?? "").toContain("structureEditor.partitionPendingOperations");
    expect(root.textContent ?? "").toContain('CREATE TABLE "public"."sales_2025"');
  });

  it("generates a partitioned CREATE TABLE from a create-mode draft", async () => {
    mocks.buildCreatePartitionedTableSql.mockResolvedValue({
      statements: ['CREATE TABLE "public"."users" (\n  "id" integer\n) PARTITION BY RANGE ("id");'],
      warnings: [],
    });

    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "",
      initialTab: "partitions",
      initialTabRequestId: 1,
      draft: structureDraft({
        activeTab: "partitions",
        newTableName: "users",
        columns: [{ id: "id", name: "id", dataType: "integer", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false }],
        createPartitioningEnabled: true,
        createPartitioningKind: "range",
        createPartitioningColumns: ["id"],
        createPartitioningExpression: "",
      }),
    });
    mountedApps.push(app);
    app.mount(root);

    await vi.waitFor(() => expect(root.querySelector('[data-tab-trigger="partitions"]')).not.toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => expect(mocks.buildCreatePartitionedTableSql).toHaveBeenCalled(), { timeout: 3000 });

    const args = mocks.buildCreatePartitionedTableSql.mock.calls.at(-1)?.[0] as {
      partitioning: { kind: string; columns: string[] };
      options: { tableName: string };
    };
    expect(args.partitioning).toEqual({ kind: "range", columns: ["id"], expression: "" });
    expect(args.options.tableName).toBe("users");
  });

  it("shows the Partitions tab for KingbaseES connections", async () => {
    // Regression: the status probe used to be gated on db_type === "postgres",
    // which hid the tab on every other PostgreSQL-family engine.
    const previous = mocks.connection.db_type;
    mocks.connection.db_type = "kingbase";
    try {
      const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });
      await settle();
      expect(root.querySelector('[data-tab-trigger="partitions"]')).not.toBeNull();
      expect(mocks.getTablePartitioning).toHaveBeenCalled();
    } finally {
      mocks.connection.db_type = previous;
    }
  });

  it("still resolves the Partitions tab when the editor opens on the DDL tab", async () => {
    // Regression: the DDL entry point skips loadStructure, so the status probe
    // never ran and the tab was missing on a partitioned table.
    const root = await mountStructureEditor({ initialTab: "ddl", initialTabRequestId: 1 });
    await settle();
    expect(root.querySelector('[data-tab-trigger="partitions"]')).not.toBeNull();
  });

  it("hides the Partitions tab for a table that is not partitioned", async () => {
    mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
    const root = await mountStructureEditor();

    await settle();
    expect(root.querySelector('[data-tab-trigger="partitions"]')).toBeNull();
    expect(mocks.getTablePartitioning).not.toHaveBeenCalled();
  });

  it("folds sub-partitions when the parent row is collapsed", async () => {
    mocks.getTablePartitioning.mockResolvedValue({
      isPartitioned: true,
      isPartition: false,
      strategy: "range",
      keyDefinition: "RANGE (year)",
      keyColumns: ["year"],
      partitions: [
        {
          schema: "public",
          name: "logs_2024",
          strategy: "list",
          isLeaf: false,
          bound: { kind: "range", from: ["2024"], to: ["2025"] },
          children: [{ schema: "public", name: "logs_2024_cn", isLeaf: true, bound: { kind: "list", values: ["'cn'"] }, children: [] }],
        },
      ],
    });
    const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });
    await settle();

    expect(root.textContent ?? "").toContain("logs_2024_cn");
    expect(root.textContent ?? "").toContain("structureEditor.partitionChildCount");

    const collapse = root.querySelector('button[title="structureEditor.partitionCollapse"]');
    expect(collapse).not.toBeNull();
    collapse!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(root.textContent ?? "").not.toContain("logs_2024_cn");
    expect(root.textContent ?? "").toContain("logs_2024");
    expect(root.querySelector('button[title="structureEditor.partitionExpand"]')).not.toBeNull();
  });

  it("previews the SQL of the operation being edited in its dialog", async () => {
    mocks.buildTablePartitionOperationSql.mockResolvedValue({
      statements: ['ALTER TABLE "public"."sales" DETACH PARTITION "public"."sales_2024";'],
      warnings: [],
    });
    const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });
    await settle();

    const detachButton = root.querySelector('button[title="structureEditor.partitionDetach"]');
    expect(detachButton).not.toBeNull();
    detachButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.buildTablePartitionOperationSql).toHaveBeenCalled(), { timeout: 3000 });
    await vi.waitFor(() => expect(root.textContent ?? "").toContain("ALTER TABLE"), { timeout: 3000 });
    expect(root.textContent ?? "").toContain("structureEditor.partitionSqlPreview");

    const options = mocks.buildTablePartitionOperationSql.mock.calls.at(-1)?.[0] as {
      operations: { kind: string; name: string }[];
    };
    expect(options.operations).toHaveLength(1);
    expect(options.operations[0]).toMatchObject({ kind: "detach", name: "sales_2024" });
  });

  it("surfaces a load failure instead of an empty state", async () => {
    mocks.getTablePartitioning.mockRejectedValue(new Error("permission denied for table pg_partitioned_table"));
    const root = await mountStructureEditor({ initialTab: "partitions", initialTabRequestId: 1 });

    await settle();
    expect(root.textContent ?? "").toContain("permission denied");
  });

  it("applies pending partition operations inside a single transaction", async () => {
    const operation = {
      id: "op:1",
      kind: "create",
      parentSchema: "",
      parentTable: "",
      schema: "",
      name: "sales_2025",
      bound: { kind: "default" },
      concurrently: false,
    };
    mocks.buildTablePartitionOperationSql.mockResolvedValue({
      statements: ['CREATE TABLE "public"."sales_2025" PARTITION OF "public"."sales" DEFAULT;'],
      warnings: [],
    });

    const root = await mountStructureEditor({
      initialTab: "partitions",
      initialTabRequestId: 1,
      draft: structureDraft({ activeTab: "partitions", partitionOperations: [operation] }),
    });
    await vi.waitFor(() => expect(mocks.buildTablePartitionOperationSql).toHaveBeenCalled(), { timeout: 3000 });
    await settle();

    await vi.waitFor(() => expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(false), { timeout: 3000 });
    buttonWithText(root, "structureEditor.apply").click();
    await vi.waitFor(() => expect(mocks.executeBatch).toHaveBeenCalledTimes(1), { timeout: 3000 });

    // A failure must not leave a half-created hierarchy behind, so the batch is
    // sent as one transaction (6th argument).
    const call = mocks.executeBatch.mock.calls[0];
    expect(call[2]).toEqual(['CREATE TABLE "public"."sales_2025" PARTITION OF "public"."sales" DEFAULT;']);
    expect(call[5]).toBe(true);
  });
});
