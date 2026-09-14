// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #8816: the editor serves its initial load from the frontend
// metadata cache, which in-app mutations only invalidate. A table rebuilt by
// another session therefore reopened with stale columns; cache-served loads
// must revalidate the affected facets in the background without clobbering
// pending user edits.

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-revalidation",
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
        h("div", attrs, slots.default?.()),
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h("button", { ...attrs, type: "button", "data-tab-trigger": props.value }, slots.default?.()),
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
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

const initialColumns = [{ name: "id", data_type: "bigint", nullable: false, default_value: null, comment: "" }];
const rebuiltColumns = [
  { name: "id", data_type: "integer", nullable: false, default_value: null, comment: "" },
  { name: "email", data_type: "varchar(255)", nullable: true, default_value: null, comment: "" },
];

function columnsFacetCalls() {
  return mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "columns");
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountStructureEditor() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    tableName: "users",
  });
  mountedApps.push(app);
  app.mount(root);
  await vi.waitFor(
    () => {
      expect(root.textContent).toContain("structureEditor.noChanges");
    },
    { timeout: 3000 },
  );
  await settle();
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor metadata revalidation (#8816)", () => {
  it("re-fetches cache-served columns in the background and applies changes on a clean draft", async () => {
    let columnsCalls = 0;
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => {
      if (facet === "columns") {
        columnsCalls += 1;
        return columnsCalls === 1 ? { value: initialColumns, cacheStatus: "memory" } : { value: rebuiltColumns, cacheStatus: "remote" };
      }
      if (facet === "comment") return { value: "", cacheStatus: "remote" };
      return { value: [], cacheStatus: "remote" };
    });

    const root = await mountStructureEditor();

    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    expect(columnsFacetCalls()[1][3]).toEqual({ force: true });
    expect(root.textContent).toContain("email");
    // The revalidation must not loop: applying happens outside loadStructure.
    await settle();
    expect(columnsFacetCalls().length).toBe(2);
  });

  it("does not re-fetch when the initial load came from the remote source", async () => {
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => {
      if (facet === "columns") return { value: initialColumns, cacheStatus: "remote" };
      if (facet === "comment") return { value: "", cacheStatus: "remote" };
      return { value: [], cacheStatus: "remote" };
    });

    const root = await mountStructureEditor();
    await settle();

    expect(columnsFacetCalls().length).toBe(1);
    expect(root.textContent).not.toContain("email");
  });

  it("keeps pending user edits when the background revalidation brings different columns", async () => {
    let columnsCalls = 0;
    let resolveRevalidation: ((result: { value: unknown; cacheStatus: string }) => void) | undefined;
    mocks.loadObjectMetadataFacet.mockImplementation((_request: unknown, facet: string) => {
      if (facet === "columns") {
        columnsCalls += 1;
        if (columnsCalls === 1) return Promise.resolve({ value: initialColumns, cacheStatus: "memory" });
        return new Promise((resolve) => {
          resolveRevalidation = resolve;
        });
      }
      if (facet === "comment") return Promise.resolve({ value: "", cacheStatus: "remote" });
      return Promise.resolve({ value: [], cacheStatus: "remote" });
    });

    const root = await mountStructureEditor();

    // The background revalidation started and is held pending.
    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    expect(resolveRevalidation).toBeDefined();

    // The user starts editing while the revalidation is in flight.
    const nameInput = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    expect(nameInput).not.toBeNull();
    nameInput!.value = "renamed_id";
    nameInput!.dispatchEvent(new Event("input"));
    await settle();

    resolveRevalidation!({ value: rebuiltColumns, cacheStatus: "remote" });
    await settle();

    const renamedInput = root.querySelector<HTMLInputElement>("[data-column-name-input]");
    expect(renamedInput?.value).toBe("renamed_id");
    expect(root.textContent).not.toContain("email");
  });

  it("applies fresh columns even when the comment revalidation fails", async () => {
    let columnsCalls = 0;
    mocks.loadObjectMetadataFacet.mockImplementation((_request: unknown, facet: string, _loader?: unknown, options?: { force?: boolean }) => {
      if (facet === "columns") {
        columnsCalls += 1;
        return Promise.resolve(columnsCalls === 1 ? { value: initialColumns, cacheStatus: "memory" } : { value: rebuiltColumns, cacheStatus: "remote" });
      }
      if (facet === "comment") {
        // Cache-served first so the file comment is part of the revalidation.
        if (options?.force) return Promise.reject(new Error("comment unavailable"));
        return Promise.resolve({ value: "", cacheStatus: "memory" });
      }
      return Promise.resolve({ value: [], cacheStatus: "remote" });
    });

    const root = await mountStructureEditor();

    await vi.waitFor(() => expect(columnsFacetCalls().length).toBe(2), { timeout: 3000 });
    await settle();
    expect(root.textContent).toContain("email");
  });
});
