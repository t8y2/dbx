// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableInfoTab, TableStructureEditorDraft } from "@/types/database";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "ddl-tab-lifecycle",
    name: "PostgreSQL",
    db_type: "postgres",
    driver_label: "PostgreSQL",
    driver_profile: "postgres",
  },
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  toast: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));

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
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("span", attrs, slots.default?.()),
    }),
  };
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
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h("button", attrs),
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
    connectionStateRevision: () => 0,
    isCurrentConnectionStateRevision: () => true,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
const settings = reactive({ editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], theme: "default", fontSize: 13, fontFamily: "monospace", generateSqlQuoteIdentifiers: true, includeDdlStorage: false, compactDdlSql: true, separateDdlIndexes: false } });
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ ...settings, updateEditorSettings: (patch: object) => Object.assign(settings.editorSettings, patch) }),
}));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copyToClipboard }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/editor/editorThemes", () => ({
  editorFontTheme: vi.fn(() => []),
  loadEditorTheme: vi.fn(async () => []),
}));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({
  loadObjectMetadataFacet: mocks.loadObjectMetadataFacet,
  invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache,
}));
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

const DDL = "CREATE TABLE users (id bigint);";
let app: App | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing ${text} button`);
  return button as HTMLButtonElement;
}

function selectTab(button: HTMLButtonElement) {
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
}

function mountDdlNavigationEditor() {
  const root = document.createElement("div");
  document.body.append(root);
  const navigation = reactive({ initialTab: "ddl" as TableInfoTab, initialTabRequestId: 1 });
  let draft: TableStructureEditorDraft | undefined;
  app = createApp({
    render: () =>
      h(TableStructureEditor, {
        connectionId: mocks.connection.id,
        database: "test",
        schema: "public",
        tableName: "users",
        ...navigation,
        "onUpdate:draft": (nextDraft: TableStructureEditorDraft | undefined) => {
          draft = nextDraft;
        },
      }),
  });
  app.mount(root);
  return { root, navigation, draft: () => draft };
}

function changeTableComment(root: HTMLElement, comment: string) {
  const input = root.querySelector<HTMLInputElement>("[data-table-comment-input]")!;
  input.value = comment;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.db_type = "postgres";
  settings.editorSettings.includeDdlStorage = !true;
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false, isForeign: false });
  mocks.getTableOwner.mockResolvedValue("app_user");
  mocks.loadObjectDdl.mockReset().mockResolvedValue({ ddl: DDL, cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
    value: facet === "columns" ? [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true }] : facet === "comment" ? "" : facet === "owner" ? "app_user" : [],
    cacheStatus: "remote",
  }));
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("TableStructureEditor DDL tab lifecycle", () => {
  it("queries fresh DDL for a new clean navigation request", async () => {
    const { root } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    expect(mocks.loadObjectDdl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tableName: "users" }), { force: true });
  });

  it("refreshes a reused clean DDL tab for a new navigation request", async () => {
    const { root, navigation } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint, external_added text);", cacheStatus: "remote" });
    navigation.initialTabRequestId++;
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("external_added"));
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(2);
    expect(mocks.loadObjectDdl.mock.calls[1][1]).toEqual({ force: true });
  });

  it("queries once when navigating back to DDL from another structure tab", async () => {
    const { root, navigation } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    selectTab(buttonWithText(root, "structureEditor.columns"));
    await nextTick();
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint, external_added text);", cacheStatus: "remote" });
    navigation.initialTabRequestId++;
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("external_added"));
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(2);
  });

  it("replaces an unchanged DDL draft after an edit was undone", async () => {
    const { root, navigation, draft } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- undone edit" } });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: DDL } });
    await vi.waitFor(() => expect(draft()?.dirty).toBe(false));
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint, external_added text);", cacheStatus: "remote" });
    navigation.initialTabRequestId++;
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("external_added"));
    expect(draft()?.ddlDraft).toBeNull();
    expect(draft()?.dirty).toBe(false);
  });

  it.each(["DDL", "table comment"])("preserves a pending %s draft when navigating to DDL again", async (editedFacet) => {
    const { root, navigation, draft } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    if (editedFacet === "DDL") {
      const { EditorView } = await import("@codemirror/view");
      const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- local draft" } });
    } else changeTableComment(root, "Local comment draft");
    await vi.waitFor(() => expect(draft()?.dirty).toBe(true));
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (external_added text);", cacheStatus: "remote" });
    navigation.initialTabRequestId++;
    await nextTick();
    await nextTick();
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".cm-content")?.textContent).toContain(DDL);
    if (editedFacet === "DDL") expect(draft()?.ddlDraft).toContain("-- local draft");
    else expect(draft()?.tableComment).toBe("Local comment draft");
    expect(draft()?.dirty).toBe(true);
  });

  it("discards a navigation refresh result if another structural draft was edited while waiting", async () => {
    const { root, navigation, draft } = mountDdlNavigationEditor();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    const pending = deferred<{ ddl: string; cacheStatus: "remote" }>();
    mocks.loadObjectDdl.mockReturnValueOnce(pending.promise);
    navigation.initialTabRequestId++;
    try {
      await vi.waitFor(() => expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(2));
      changeTableComment(root, "Draft entered while waiting");
      await vi.waitFor(() => expect(draft()?.dirty).toBe(true));
    } finally {
      pending.resolve({ ddl: "CREATE TABLE users (external_added text);", cacheStatus: "remote" });
    }
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL));
    expect(root.querySelector(".cm-content")?.textContent).not.toContain("external_added");
    expect(draft()?.tableComment).toBe("Draft entered while waiting");
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- keep this baseline" } });
    await vi.waitFor(() => expect(draft()?.ddlDraft).toContain("-- keep this baseline"));
    expect(draft()?.rawDdlContent).toContain(DDL);
    expect(draft()?.rawDdlContent).not.toContain("external_added");
  });

  it.each(["oracle", "oceanbase-oracle"])("reloads %s DDL for independent indexes and freezes an edited draft", async (type) => {
    mocks.connection.db_type = type;
    mocks.loadObjectDdl.mockResolvedValueOnce({ ddl: 'CREATE TABLE "T" ("ID" NUMBER);', cacheStatus: "remote" }).mockResolvedValueOnce({ ddl: 'CREATE TABLE "T" ("ID" NUMBER);\nCREATE INDEX "DETACHED" ON "T"("ID");', cacheStatus: "remote" });
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, { connectionId: mocks.connection.id, database: "service", schema: "Exact Owner", tableName: "T", initialTab: "ddl" });
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain('"ID"'));
    const option = () => root.querySelector<HTMLButtonElement>('[id$="-separateDdlIndexes"]')!;
    option().click();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("DETACHED"));
    expect(mocks.loadObjectDdl.mock.calls[1][0]).toMatchObject({ connectionId: mocks.connection.id, database: "service", schema: "Exact Owner", tableName: "T", separateIndexes: true });
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- preserved draft" } });
    await vi.waitFor(() => expect(option().disabled).toBe(true));
    settings.editorSettings.separateDdlIndexes = false;
    await nextTick();
    expect(root.querySelector(".cm-content")?.textContent).toContain("-- preserved draft");
    expect(option().getAttribute("aria-checked")).toBe("true");
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(2);
  });

  it("keeps failed index metadata out of the editable SQL and permits switching the option off", async () => {
    mocks.connection.db_type = "oracle";
    mocks.loadObjectDdl.mockResolvedValueOnce({ ddl: 'CREATE TABLE "T" ("ID" NUMBER);', cacheStatus: "remote" }).mockRejectedValueOnce(new Error("index metadata unavailable")).mockResolvedValueOnce({ ddl: 'CREATE TABLE "T" ("ID" NUMBER);', cacheStatus: "remote" });
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, { connectionId: mocks.connection.id, database: "APP", schema: "APP", tableName: "T", initialTab: "ddl" });
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain('"ID"'));
    const option = () => root.querySelector<HTMLButtonElement>('[id$="-separateDdlIndexes"]')!;
    option().click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe("index metadata unavailable"));
    expect(root.querySelector(".structure-ddl-editor")).toBeNull();
    expect(buttonWithText(root, "grid.copyDdl").disabled).toBe(true);
    expect(option().disabled).toBe(false);
    option().click();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain('"ID"'));
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.loadObjectDdl.mock.calls[2][0].separateIndexes).toBe(false);
  });

  it("restores a legacy edited DDL baseline without adopting new display defaults", async () => {
    mocks.connection.db_type = "oceanbase-oracle";
    const original = 'CREATE   TABLE "T" (\n\n  "ID"   NUMBER) PCTFREE=0;';
    mocks.loadObjectDdl.mockResolvedValue({ ddl: original, cacheStatus: "remote" });
    const root = document.createElement("div");
    document.body.append(root);
    let saved: any;
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "T",
      initialTab: "ddl",
      "onUpdate:draft": (draft: unknown) => {
        saved = draft;
      },
    });
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain('"ID"'));
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- draft" } });
    await vi.waitFor(() => expect(saved?.ddlDraft).toContain("-- draft"));
    const legacy = { ...saved, rawDdlContent: original, ddlContent: original, ddlDraft: original + "\n-- draft" };
    delete legacy.includeDdlStorage;
    delete legacy.excludeDdlStorage;
    delete legacy.compactDdlSql;
    delete legacy.separateDdlIndexes;
    app.unmount();
    root.replaceChildren();
    app = createApp(TableStructureEditor, { connectionId: mocks.connection.id, database: "APP", schema: "APP", tableName: "T", initialTab: "ddl", draft: legacy });
    app.mount(root);
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("-- draft"));
    expect(root.querySelector(".cm-content")?.textContent).toContain("PCTFREE=0");
    expect(root.querySelector(".cm-content")?.textContent).toContain("CREATE   TABLE");
    expect(root.querySelector<HTMLButtonElement>('[role="switch"][id$="-includeDdlStorage"]')?.disabled).toBe(true);
    expect(root.querySelector('[role="switch"][id$="-includeDdlStorage"]')?.getAttribute("aria-checked")).toBe("true");
    expect(root.querySelector('[role="switch"][id$="-compactDdlSql"]')?.getAttribute("aria-checked")).toBe("false");
    buttonWithText(root, "structureEditor.resetDdl").click();
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).not.toContain("PCTFREE"));
  });

  it("toggles OceanBase storage, copies the displayed DDL and protects an edited draft", async () => {
    mocks.connection.db_type = "oceanbase-oracle";
    const ddl = 'CREATE TABLE "T" ("ID" NUMBER) PCTFREE=0 PARTITION BY HASH("ID") PARTITIONS 2;';
    mocks.loadObjectDdl.mockResolvedValue({ ddl, cacheStatus: "remote" });
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, { connectionId: mocks.connection.id, database: "APP", schema: "APP", tableName: "T", initialTab: "ddl" });
    app.mount(root);
    const content = () => root.querySelector(".cm-content")?.textContent ?? "";
    const toggle = () => root.querySelector<HTMLButtonElement>('[role="switch"][id$="-includeDdlStorage"]')!;
    await vi.waitFor(
      () => {
        expect(content()).toMatch(/PARTITION BY\s+HASH/);
        expect(root.querySelector('[role="switch"]')).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(content()).not.toContain("PCTFREE");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    toggle().click();
    await vi.waitFor(() => expect(content()).toContain("PCTFREE"), { timeout: 5000 });
    buttonWithText(root, "grid.copyDdl").click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(content()), { timeout: 5000 });
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(root.querySelector(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- local edit" } });
    await nextTick();
    expect(toggle().disabled).toBe(true);
    settings.editorSettings.includeDdlStorage = !true;
    await nextTick();
    expect(content()).toContain("PCTFREE");
    expect(content()).toContain("-- local edit");
    buttonWithText(root, "structureEditor.resetDdl").click();
    await vi.waitFor(() => expect(content()).not.toContain("PCTFREE"), { timeout: 5000 });
    expect(content()).not.toContain("-- local edit");
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
  });
  it("restores cached DDL after switching to columns and back", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "ddl",
    });
    app.mount(root);

    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL), { timeout: 5000 });

    const columnsTab = buttonWithText(root, "structureEditor.columns");
    selectTab(columnsTab);
    await nextTick();
    await vi.waitFor(() => expect(columnsTab.getAttribute("data-state")).toBe("active"));

    const inactiveDdlContainer = root.querySelector(".structure-ddl-editor");
    expect(inactiveDdlContainer).not.toBeNull();
    const inactiveDdlPanel = inactiveDdlContainer?.closest('[data-slot="tabs-content"]');
    expect(inactiveDdlPanel?.getAttribute("data-state")).toBe("inactive");
    expect(inactiveDdlPanel?.classList.contains("data-[state=inactive]:hidden")).toBe(true);
    await vi.waitFor(() => expect(inactiveDdlContainer?.querySelector(".cm-content")).toBeNull());

    selectTab(buttonWithText(root, "DDL"));
    await nextTick();

    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL), { timeout: 5000 });
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
  });

  it("does not restart the new tab's metadata load when a stale DDL request resolves", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "triggers",
    });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet.mock.calls.some((call) => call[1] === "triggers")).toBe(true));

    const ddlResult = deferred<{ ddl: string; cacheStatus: "remote" }>();
    const columnsResult = deferred<Array<{ name: string; data_type: string; is_nullable: boolean; column_default: null; is_primary_key: boolean }>>();
    mocks.loadObjectDdl.mockImplementationOnce(() => ddlResult.promise);
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value: facet === "columns" ? await columnsResult.promise : facet === "comment" ? "Application users" : facet === "owner" ? "app_user" : [],
      cacheStatus: "remote",
    }));

    selectTab(buttonWithText(root, "DDL"));
    await vi.waitFor(() => expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1));
    selectTab(buttonWithText(root, "structureEditor.columns"));
    await vi.waitFor(() => expect(mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "columns")).toHaveLength(1));

    ddlResult.resolve({ ddl: DDL, cacheStatus: "remote" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const columnLoadsAfterDdl = mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "columns").length;
    columnsResult.resolve([{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true }]);

    expect(columnLoadsAfterDdl).toBe(1);
  });

  it("force-refreshes both DDL and the visible table comment", async () => {
    let tableComment = "Old comment";
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value: facet === "columns" ? [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true }] : facet === "comment" ? tableComment : facet === "owner" ? "app_user" : [],
      cacheStatus: "remote",
    }));

    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "ddl",
    });
    app.mount(root);

    const commentInput = () => root.querySelector<HTMLInputElement>('input[placeholder="structureEditor.tableCommentPlaceholder"]');
    await vi.waitFor(() => expect(commentInput()?.value).toBe("Old comment"));
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain(DDL), { timeout: 5000 });

    tableComment = "Updated comment";
    mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint, name text);", cacheStatus: "remote" });
    buttonWithText(root, "structureEditor.refresh").click();

    await vi.waitFor(() => expect(commentInput()?.value).toBe("Updated comment"));
    await vi.waitFor(() => expect(root.querySelector(".cm-content")?.textContent).toContain("name text"), { timeout: 5000 });
    const commentCalls = mocks.loadObjectMetadataFacet.mock.calls.filter((call) => call[1] === "comment");
    expect(commentCalls).toHaveLength(2);
    expect(commentCalls.at(-1)?.[3]).toEqual({ force: true });
  });

  it("refreshes the open table on F5 after the desktop reload guard", async () => {
    let tableComment = "Old comment";
    mocks.loadObjectMetadataFacet.mockImplementation(async (_request, facet: string) => ({
      value: facet === "columns" ? [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true }] : facet === "comment" ? tableComment : facet === "owner" ? "app_user" : [],
      cacheStatus: "remote",
    }));
    const pendingDdl = deferred<{ ddl: string; cacheStatus: "remote" }>();
    mocks.loadObjectDdl.mockImplementationOnce(() => pendingDdl.promise);

    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "ddl",
    });
    app.mount(root);

    const refreshButton = () => buttonWithText(root, "structureEditor.refresh");
    await vi.waitFor(() => expect(refreshButton().disabled).toBe(true));
    // F5 originates inside the editor (bubbles up to the window-level listener).
    refreshButton().dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
    expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateObjectDdl).not.toHaveBeenCalled();

    pendingDdl.resolve({ ddl: DDL, cacheStatus: "remote" });
    const commentInput = () => root.querySelector<HTMLInputElement>('input[placeholder="structureEditor.tableCommentPlaceholder"]');
    await vi.waitFor(() => expect(refreshButton().disabled).toBe(false));
    await vi.waitFor(() => expect(commentInput()?.value).toBe("Old comment"));
    expect(refreshButton().getAttribute("aria-keyshortcuts")).toBe("F5");
    expect(refreshButton().getAttribute("title")).toBe("structureEditor.refresh (F5)");

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogInput = document.createElement("input");
    dialog.append(dialogInput);
    document.body.append(dialog);
    dialogInput.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
    await nextTick();
    expect(mocks.invalidateObjectDdl).not.toHaveBeenCalled();
    dialog.remove();

    const blockBrowserReload = (event: KeyboardEvent) => {
      if (event.key === "F5") event.preventDefault();
    };
    window.addEventListener("keydown", blockBrowserReload, true);
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true, ctrlKey: true }));
      await nextTick();
      expect(mocks.invalidateObjectDdl).not.toHaveBeenCalled();

      tableComment = "Updated comment";
      mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE users (id bigint, name text);", cacheStatus: "remote" });
      refreshButton().dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(commentInput()?.value).toBe("Updated comment"));
      expect(mocks.invalidateObjectDdl).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", blockBrowserReload, true);
    }
  });

  it("ignores F5 dispatched from outside the editor root", async () => {
    // The keydown listener is window-level and shared by every activated structure
    // editor; an F5 typed in another editor group (e.g. the global refresh-data
    // shortcut) must not discard this editor's drafts.
    mocks.loadObjectDdl.mockResolvedValue({ ddl: DDL, cacheStatus: "remote" });
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "users",
      initialTab: "ddl",
    });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1));
    const outside = document.createElement("input");
    document.body.append(outside);
    try {
      outside.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
      await nextTick();
      expect(mocks.invalidateObjectDdl).not.toHaveBeenCalled();
      expect(mocks.loadObjectDdl).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });

  it("leaves a create-table draft alone on F5", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      schema: "public",
      tableName: "",
    });
    app.mount(root);

    await nextTick();
    expect(root.textContent).not.toContain("structureEditor.refresh");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true }));
    await nextTick();
    expect(mocks.invalidateObjectDdl).not.toHaveBeenCalled();
  });
});
