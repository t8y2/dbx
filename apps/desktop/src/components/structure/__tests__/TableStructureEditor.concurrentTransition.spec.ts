// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-concurrent-transition",
    name: "PostgreSQL",
    db_type: "postgres",
    driver_label: "PostgreSQL",
  },
  ensureConnected: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  getTablePartitionStatus: vi.fn(),
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
// Tabs mock that wires TabsTrigger clicks through `v-model` (the real tabs
// component does this internally via context; the primaryKey spec mock renders
// every tab pane unconditionally, which we keep so draft rows stay queryable
// regardless of the active tab).
vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h, inject, provide } = await import("vue");
  const TabsKey = Symbol("tabs:model");
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
    setup: (_props, { attrs, slots, emit }) => {
      provide(TabsKey, (value: string) => emit("update:modelValue", value));
      return () => h("div", attrs, slots.default?.());
    },
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup: (props, { attrs, slots }) => {
      const select = inject<(value: string) => void>(TabsKey, () => {});
      return () => h("button", { ...attrs, type: "button", onClick: () => select(props.value) }, slots.default?.());
    },
  });
  return { Tabs, TabsContent: Div, TabsList: Div, TabsTrigger };
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
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

async function mountIndexesEditor() {
  mocks.connection.db_type = "postgres";
  mocks.connection.name = "postgres";
  mocks.connection.driver_label = "postgres";
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
    value: facet === "comment" ? "" : [],
    cacheStatus: "remote",
  }));
  // The SQL builder mirrors the Concurrent checkbox onto the generated
  // statement so the enabled phase of the regression is visibly concurrent.
  mocks.buildTableStructureChangeSql.mockImplementation((options: { indexes?: Array<{ name: string; concurrently?: boolean }> }) => {
    const newIndex = options.indexes?.[0];
    const statements = newIndex ? [`${newIndex.concurrently ? "CREATE INDEX CONCURRENTLY" : "CREATE INDEX"} "${newIndex.name || "idx_users_email"}" ON "public"."users" ("email");`] : [];
    return Promise.resolve({ statements, warnings: [] });
  });

  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(TableStructureEditor, {
    connectionId: mocks.connection.id,
    database: "test",
    schema: "public",
    tableName: "users",
    initialTab: "indexes",
  });
  mountedApps.push(app);
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return root;
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing ${text} button`);
  return button as HTMLButtonElement;
}

/** The Concurrent checkbox inside the given index row (identified by the
 * tooltip the cell label carries: concurrentTooltip / ...ExistingIndex /
 * ...Partitioned / ...Unavailable). */
function concurrentCheckboxInRow(row: HTMLElement): HTMLInputElement {
  const input = Array.from(row.querySelectorAll<HTMLInputElement>('label[title*="concurrent"] input[type="checkbox"]'))[0];
  if (!input) throw new Error("Missing Concurrent checkbox in index row");
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
});

afterEach(() => {
  vi.useRealTimers();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor concurrent availability transition", () => {
  it("preserves Concurrent intent across a failed partition probe and restores its SQL after recovery", async () => {
    const root = await mountIndexesEditor();

    // Enabled phase: new index can select Concurrent and the preview builds
    // a CREATE INDEX CONCURRENTLY statement.
    await vi.waitFor(() => expect(buttonWithText(root, "structureEditor.addIndex").disabled).toBe(false), { timeout: 3000 });
    buttonWithText(root, "structureEditor.addIndex").click();
    await nextTick();
    await vi.waitFor(
      () => {
        const row = root.querySelector<HTMLElement>('[data-new-index-row="true"]');
        expect(row).not.toBeNull();
      },
      { timeout: 3000 },
    );
    const row = root.querySelector<HTMLElement>('[data-new-index-row="true"]')!;
    const concurrent = concurrentCheckboxInRow(row);
    expect(concurrent.disabled).toBe(false);
    expect(concurrent.checked).toBe(false);

    concurrent.checked = true;
    concurrent.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql.mock.calls.at(-1)?.[0]?.indexes?.[0]?.concurrently).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(root.textContent).toContain('CREATE INDEX CONCURRENTLY "idx_users_email" ON "public"."users" ("email");'), { timeout: 3000 });
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(false);
    const callsAtEnabledPhase = mocks.buildTableStructureChangeSql.mock.calls.length;

    // Transition: the very next partition-status probe fails. A reload that
    // re-runs the probe (here: switching to a tab with an unloaded metadata
    // facet) must keep the draft index but treat Concurrent as unavailable.
    mocks.getTablePartitionStatus.mockRejectedValue(new Error("partition probe unavailable"));
    await vi.waitFor(() => expect(buttonWithText(root, "structureEditor.triggers")).toBeTruthy(), { timeout: 3000 });
    buttonWithText(root, "structureEditor.triggers").click();
    await vi.waitFor(() => expect(mocks.getTablePartitionStatus).toHaveBeenCalledTimes(2), { timeout: 3000 });

    // Fail closed while preserving the user's transiently unavailable intent:
    // no SQL reaches the builder, the checkbox is disabled, and Save stays blocked.
    await vi.waitFor(() => expect(root.textContent).toContain("structureEditor.concurrentUnavailableBlocksSave"), { timeout: 3000 });
    const unavailableRow = root.querySelector<HTMLElement>('[data-new-index-row="true"]');
    expect(unavailableRow).not.toBeNull();
    const unavailableConcurrent = concurrentCheckboxInRow(unavailableRow!);
    expect(unavailableConcurrent.checked).toBe(true);
    expect(unavailableConcurrent.disabled).toBe(true);

    // Neither the stale concurrent request nor a silent blocking downgrade may
    // reach the SQL builder or the preview after the transition.
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(true);
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBe(callsAtEnabledPhase), { timeout: 3000 });
    expect(root.textContent).not.toContain("CREATE INDEX CONCURRENTLY");
    expect(root.textContent).not.toContain('CREATE INDEX "idx_users_email"');

    // Recovery: a later successful probe must lift the blocker and regenerate
    // the preview with the original Concurrent intent, never a blocking CREATE.
    mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
    buttonWithText(root, "structureEditor.refresh").click();
    await vi.waitFor(() => expect(mocks.getTablePartitionStatus).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await vi.waitFor(() => expect(mocks.buildTableStructureChangeSql.mock.calls.length).toBeGreaterThan(callsAtEnabledPhase), { timeout: 3000 });

    const recoveredRow = root.querySelector<HTMLElement>('[data-new-index-row="true"]');
    expect(recoveredRow).not.toBeNull();
    const recoveredConcurrent = concurrentCheckboxInRow(recoveredRow!);
    expect(recoveredConcurrent.checked).toBe(true);
    expect(recoveredConcurrent.disabled).toBe(false);
    expect(mocks.buildTableStructureChangeSql.mock.calls.at(-1)?.[0]?.indexes?.[0]?.concurrently).toBe(true);
    await vi.waitFor(() => expect(root.textContent).toContain('CREATE INDEX CONCURRENTLY "idx_users_email" ON "public"."users" ("email");'), { timeout: 3000 });
    expect(root.textContent).not.toContain('CREATE INDEX "idx_users_email"');
    expect(buttonWithText(root, "structureEditor.apply").disabled).toBe(false);
  });
});
