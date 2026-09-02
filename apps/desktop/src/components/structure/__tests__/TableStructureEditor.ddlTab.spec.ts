// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TABLE_DDL = "CREATE TABLE `users` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `email` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-ddl-tab",
    name: "MySQL",
    db_type: "mysql",
    driver_label: "MySQL",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
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
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], fontSize: 13, fontFamily: "monospace", theme: "default" },
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
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];
let lastDraft: Record<string, unknown> | undefined;

async function mountStructureEditor() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    tableName: "users",
    initialTab: "columns",
    "onUpdate:draft": (draft: Record<string, unknown> | undefined) => {
      lastDraft = draft;
    },
  });
  mountedApps.push(app);
  app.mount(root);
  // The tab list lives inside the `v-else` of the loading branch, so every tab
  // must be driven from a fully settled editor: a straggling metadata load
  // would otherwise unmount the whole pane between query and click.
  await vi.waitFor(
    () => {
      expect(root.querySelector('[data-tab-trigger="ddl"]')).not.toBeNull();
      expect(buttonWithText(root, "structureEditor.addColumn").disabled).toBe(false);
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

async function clickTab(root: HTMLElement, tab: string) {
  await vi.waitFor(
    () => {
      const trigger = root.querySelector<HTMLButtonElement>(`[data-tab-trigger="${tab}"]`);
      expect(trigger).not.toBeNull();
      trigger!.click();
    },
    { timeout: 3000 },
  );
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing ${text} button`);
  return button as HTMLButtonElement;
}

function ddlEditorText(root: HTMLElement): string {
  return root.querySelector(".structure-ddl-editor .cm-content")?.textContent ?? "";
}

/** The live CodeMirror view behind the DDL pane, so edits go through real transactions. */
function ddlEditorView(root: HTMLElement): EditorView {
  const dom = root.querySelector<HTMLElement>(".structure-ddl-editor .cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("Missing DDL CodeMirror view");
  return view;
}

async function openDdlTab(root: HTMLElement) {
  await clickTab(root, "ddl");
  await vi.waitFor(() => expect(ddlEditorText(root)).toContain("CREATE TABLE"), { timeout: 3000 });
}

async function editDdl(root: HTMLElement, script: string) {
  const view = ddlEditorView(root);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: script } });
  await nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  lastDraft = undefined;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
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

describe("TableStructureEditor DDL tab", () => {
  it("keeps the DDL rendered when the tab is left and revisited", async () => {
    // Regression for #7818/#7778: the second visit re-mounts the pane one tick
    // after the tab activates, and nothing re-fetches (the DDL is already
    // cached), so an init tied to a single nextTick left the tab blank forever.
    const root = await mountStructureEditor();
    await openDdlTab(root);

    await clickTab(root, "columns");
    await vi.waitFor(() => expect(root.querySelector(".structure-ddl-editor")).toBeNull(), { timeout: 3000 });
    await settle();

    await openDdlTab(root);
    expect(ddlEditorText(root)).toContain("CREATE TABLE");
    expect(ddlEditorText(root)).toContain("AUTO_INCREMENT");
    // The revisit must not have refetched: the fix has to work off cached DDL.
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
  });

  it("executes an edited DDL script as the previewed batch", async () => {
    const root = await mountStructureEditor();
    await openDdlTab(root);

    await editDdl(root, "ALTER TABLE `users` ADD COLUMN `nickname` varchar(64);\nALTER TABLE `users` ADD INDEX `idx_email` (`email`);");

    await vi.waitFor(() => expect(root.textContent).toContain("ALTER TABLE `users` ADD COLUMN `nickname` varchar(64)"), { timeout: 3000 });
    expect(root.textContent).toContain("structureEditor.ddlEditNotice");
    await vi.waitFor(() => expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(false), { timeout: 3000 });

    buttonWithText(root, "structureEditor.apply").click();
    await vi.waitFor(() => expect(mocks.executeBatch).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mocks.executeBatch.mock.calls[0][2]).toEqual(["ALTER TABLE `users` ADD COLUMN `nickname` varchar(64)", "ALTER TABLE `users` ADD INDEX `idx_email` (`email`)"]);
    // The structure builder must not have contributed statements to that batch.
    expect(mocks.buildTableStructureChangeSql).not.toHaveBeenCalled();
  });

  it("carries the edited script in the draft so the tab reports unsaved work", async () => {
    const root = await mountStructureEditor();
    await openDdlTab(root);
    await editDdl(root, "ALTER TABLE `users` ADD COLUMN `nickname` varchar(64);");

    await vi.waitFor(() => expect(lastDraft?.ddlDraft).toContain("ADD COLUMN `nickname`"), { timeout: 3000 });
    // `dirty` is what the tab-close guard reads: DDL edits must count as unsaved.
    expect(lastDraft?.dirty).toBe(true);
    expect(lastDraft?.ddlContent).toContain("CREATE TABLE");
    expect(root.querySelector("[data-ddl-dirty-indicator]")).not.toBeNull();
  });

  it("restores the database DDL and drops the pending batch on reset", async () => {
    const root = await mountStructureEditor();
    await openDdlTab(root);
    await editDdl(root, "DROP TABLE `users`;");
    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.ddlEditNotice"), { timeout: 3000 });

    buttonWithText(root, "structureEditor.resetDdl").click();
    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.noChanges"), { timeout: 3000 });
    expect(root.textContent).not.toContain("structureEditor.ddlEditNotice");
    expect(ddlEditorText(root)).toContain("CREATE TABLE");
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(true);
  });

  it("refuses to save when the DDL script and the structure tabs were both edited", async () => {
    const root = await mountStructureEditor();
    buttonWithText(root, "structureEditor.addColumn").click();
    await nextTick();

    await openDdlTab(root);
    await editDdl(root, "ALTER TABLE `users` ADD COLUMN `nickname` varchar(64);");

    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.ddlEditConflictsWithStructure"), { timeout: 3000 });
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(true);

    buttonWithText(root, "structureEditor.apply").click();
    await nextTick();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });
});
