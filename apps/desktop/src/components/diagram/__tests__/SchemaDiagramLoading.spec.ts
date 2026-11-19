// @vitest-environment happy-dom
import { createApp, nextTick, reactive, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFocusedDiagramCacheForTests } from "@/lib/diagram/diagramMetadataCache";
import { loadDraftTables, loadLiveTablePatches, loadPersistedLayers, loadPersistedPositions, saveDraftTables, saveLiveTablePatches, savePersistedLayers, savePersistedPositions } from "@/lib/diagram/draft-storage";
import type { DiagramTable } from "@/lib/diagram/erDiagram";
import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from "@/types/database";
import type { DiagramNode, DiagramEdge, DiagramLayer } from "@/types/diagram";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(async () => {}),
  toast: vi.fn(),
  listDatabases: vi.fn(async () => [{ name: "db" }]),
  listSchemas: vi.fn(async () => ["public", "other"]),
  listTables: vi.fn(async () => ["A", "B", "C", "unrelated"].map((name) => ({ name, table_type: "TABLE" }))),
  getColumns: vi.fn(async () => [{ name: "id", data_type: "int", is_nullable: false, is_primary_key: true, column_default: null, extra: null }]),
  listForeignKeys: vi.fn(async (_id: string, _db: string, _schema: string, name: string): Promise<ForeignKeyInfo[]> => (name === "A" || name === "B" ? [{ name: "fk", column: "id", ref_table: name === "A" ? "B" : "C", ref_column: "id" }] : [])),
  listForeignKeysForDatabase: vi.fn(async () => ({})),
  listIndexes: vi.fn(async () => []),
  getTableComment: vi.fn(async () => null),
  fitView: vi.fn(),
  setViewport: vi.fn(),
  layout: vi.fn(async (nodes: DiagramNode[], edges: DiagramEdge[], layers: DiagramLayer[]) => ({
    nodes: nodes.map((node, index) => ({ ...node, position: layers.some((layer) => layer.layoutMode === "free" && layer.tableNames.includes(node.id)) ? node.position : { x: 80 + index * 400, y: 80 } })),
    edges,
    layerLayouts: [],
  })),
}));
vi.mock("@/lib/diagram/elk-layout", () => ({ computeLayoutWithLayers: mocks.layout }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c", db_type: "postgres" }], getConfig: () => ({ id: "c", db_type: "postgres" }), ensureConnected: mocks.ensureConnected }) }));
vi.mock("@vue-flow/core", async () => {
  const { ref } = await import("vue");
  return {
    VueFlow: {},
    useVueFlow: () => {
      const nodes = ref([]);
      const edges = ref([]);
      return {
        nodes,
        edges,
        setNodes: (value: []) => {
          nodes.value = value;
        },
        setEdges: (value: []) => {
          edges.value = value;
        },
        fitView: mocks.fitView,
        setViewport: mocks.setViewport,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      };
    },
  };
});
vi.mock("../DiagramInspector.vue", () => ({ default: {} }));
vi.mock("../DiagramSyncDialog.vue", () => ({ default: {} }));
vi.mock("../CreateDraftTableDialog.vue", () => ({ default: {} }));
vi.mock("../TableNode.vue", () => ({ default: {} }));
vi.mock("../LayerNode.vue", () => ({ default: {} }));
vi.mock("../RelationshipEdge.vue", () => ({ default: {} }));
vi.mock("../MatchPanel.vue", () => ({ default: {} }));
vi.mock("../DiagramToolbar.vue", () => ({ default: {} }));
vi.mock("../LayerPanel.vue", () => ({ default: {} }));
import SchemaDiagramDialog from "../SchemaDiagramDialog.vue";

const mounted: App[] = [];
async function settle() {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

async function mountDialog(focused = true, overrides: { focusTableNames?: string[]; prefillSchema?: string } = {}) {
  const props = reactive({ open: true, prefillConnectionId: "c", prefillDatabase: "db", prefillSchema: "public", prefillCatalog: "catalog", focusTableName: focused ? "A" : "", ...overrides });
  // Exercise the actual SFC setup, watchers, loaders and layout/persistence with the canvas renderer omitted.
  const app = createApp({ ...SchemaDiagramDialog, render: () => null }, props);
  app.use(createPinia());
  const instance = app.mount(document.createElement("div"));
  mounted.push(app);
  const state = instance.$.setupState as any;
  await settle();
  return { app, state, props };
}

beforeEach(() => {
  clearFocusedDiagramCacheForTests();
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

describe("diagram loading integration", () => {
  it("uses real ELK for initial and manual layout with the same result", async () => {
    const elk = await vi.importActual<typeof import("@/lib/diagram/elk-layout")>("@/lib/diagram/elk-layout");
    savePersistedPositions({ A: { x: 9000, y: 8000 }, B: { x: 15000, y: 10000 } }, "c", "db", "public");
    mocks.layout.mockImplementationOnce(elk.computeLayoutWithLayers);
    const { state } = await mountDialog();
    await vi.waitFor(() => expect(state.layoutBusy).toBe(false), { timeout: 10000 });
    const initial = JSON.parse(JSON.stringify(state.positions));
    expect(initial.A).not.toEqual({ x: 9000, y: 8000 });
    expect(new Set(Object.values(initial).map((position) => JSON.stringify(position))).size).toBe(3);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(state.graphStore.canUndo).toBe(false);
    mocks.layout.mockImplementationOnce(elk.computeLayoutWithLayers);
    await state.applyAutoLayout();
    expect(state.positions).toEqual(initial);
    expect(state.graphStore.canUndo).toBe(true);
  });

  it("replaces previous schema-wide positions on initial focused open before fitting, without undo history", async () => {
    savePersistedPositions({ A: { x: 9000, y: 8000 }, unrelated: { x: 7000, y: 6000 } }, "c", "db", "public");
    const { state } = await mountDialog();
    expect(mocks.layout).toHaveBeenCalledTimes(1);
    expect(mocks.layout.mock.calls[0][0].map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(state.positions.A).toEqual({ x: 80, y: 80 });
    expect(state.graphStore.canUndo).toBe(false);
    expect(mocks.fitView).toHaveBeenCalledTimes(1);
    expect(mocks.fitView.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.layout.mock.invocationCallOrder[0]);
    expect(loadPersistedPositions("c", "db", "public").unrelated).toEqual({ x: 7000, y: 6000 });
    expect(state.layoutBusy).toBe(false);
  });

  it("initializes full diagrams through the same layout pipeline and preserves free layer positions", async () => {
    savePersistedPositions({ A: { x: 900, y: 800 }, B: { x: 950, y: 1200 } }, "c", "db", "public");
    savePersistedLayers([{ id: "free", name: "Free", color: "red", visible: true, collapsed: false, layoutMode: "free", tableNames: ["A", "B"] }], "c", "db", "public");
    const { state } = await mountDialog(false);
    expect(mocks.layout).toHaveBeenCalledTimes(1);
    expect(mocks.layout.mock.calls[0][0]).toHaveLength(4);
    expect(state.positions.A).toEqual({ x: 900, y: 800 });
    expect(state.positions.B).toEqual({ x: 950, y: 1200 });
    expect(state.graphStore.canUndo).toBe(false);
  });

  it("locks manual layout during a cached scope transition and only lays out its committed closure", async () => {
    const { state } = await mountDialog();
    await state.handleToggleShowAllTables();
    const unrelated = loadPersistedPositions("c", "db", "public").unrelated;
    vi.clearAllMocks();
    const transition = state.handleToggleShowAllTables();
    expect(state.layoutBusy).toBe(true);
    await state.applyAutoLayout();
    await transition;
    expect(mocks.layout).toHaveBeenCalledTimes(1);
    expect(mocks.layout.mock.calls[0][0].map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(mocks.layout.mock.calls[0][1].every((edge) => edge.source !== "unrelated" && edge.target !== "unrelated")).toBe(true);
    expect(mocks.getColumns).not.toHaveBeenCalled();
    expect(loadPersistedPositions("c", "db", "public").unrelated).toEqual(unrelated);
    await state.applyAutoLayout();
    expect(state.graphStore.canUndo).toBe(true);
    state.handleUndo();
    expect(state.graphStore.canUndo).toBe(false);
    state.tableSearch = "A";
    state.showLayersPanel = true;
    await settle();
    expect(mocks.layout).toHaveBeenCalledTimes(2);
  });

  it("does not reflow hidden, unrelated draft, or incomplete layer geometry", async () => {
    saveDraftTables([{ name: "draft_elsewhere", schema: "public", origin: "draft", columns: [], foreignKeys: [] }], "c", "db", "public");
    const layer: DiagramLayer = { id: "partial", name: "Partial", color: "red", visible: true, collapsed: false, tableNames: ["A", "unrelated"], position: { x: 10, y: 20 }, width: 900, height: 600 };
    const hidden: DiagramLayer = { ...layer, id: "hidden", visible: false, tableNames: ["C"] };
    savePersistedLayers([layer, hidden], "c", "db", "public");
    savePersistedPositions({ C: { x: 1000, y: 1200 }, unrelated: { x: 2000, y: 2000 } }, "c", "db", "public");
    await mountDialog();
    expect(mocks.layout.mock.calls[0][0].map((node) => node.id)).toEqual(["A", "B"]);
    expect(mocks.layout.mock.calls[0][2]).toEqual([]);
    expect(loadPersistedLayers("c", "db", "public")).toEqual([layer, hidden].map((item) => ({ ...item, layoutMode: "auto" })));
    expect(loadPersistedPositions("c", "db", "public").C).toEqual({ x: 1000, y: 1200 });
  });

  it("discards an older layout result after a newer refresh", async () => {
    const { state } = await mountDialog();
    const pending = deferred<Awaited<ReturnType<typeof mocks.layout>>>();
    mocks.layout.mockImplementationOnce(() => pending.promise);
    const layout = state.applyAutoLayout();
    await settle();
    await state.loadDiagram({ force: true });
    const current = JSON.parse(JSON.stringify(state.positions));
    const persisted = loadPersistedPositions("c", "db", "public");
    const fits = mocks.fitView.mock.calls.length;
    pending.resolve({ nodes: [{ id: "A", type: "table", position: { x: -999, y: -999 } }], edges: [], layerLayouts: [] });
    await layout;
    expect(state.positions).toEqual(current);
    expect(loadPersistedPositions("c", "db", "public")).toEqual(persisted);
    expect(mocks.fitView).toHaveBeenCalledTimes(fits);
    expect(state.graphStore.canUndo).toBe(false);
  });

  it("does not commit or persist a layout after the dialog closes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof mocks.layout>>>();
    mocks.layout.mockImplementationOnce(() => pending.promise);
    const { state } = await mountDialog();
    state.open = false;
    await settle();
    pending.resolve({ nodes: [{ id: "A", type: "table", position: { x: -999, y: -999 } }], edges: [], layerLayouts: [] });
    await settle();
    expect(loadPersistedPositions("c", "db", "public")).toEqual({});
    expect(mocks.fitView).not.toHaveBeenCalled();
    expect(state.layoutBusy).toBe(false);
  });

  it("keeps a usable graph with fallback positions when ELK fails and permits retry", async () => {
    mocks.layout.mockRejectedValueOnce(new Error("layout failed"));
    const { state } = await mountDialog();
    expect(state.tables).toHaveLength(3);
    expect(state.positions.A).toBeDefined();
    expect(state.positions.A).not.toEqual(state.positions.B);
    expect(mocks.toast).toHaveBeenCalledWith("layout failed", 5000);
    expect(state.layoutBusy).toBe(false);
    await state.applyAutoLayout();
    expect(mocks.layout).toHaveBeenCalledTimes(2);
  });

  it("sets schema-aware focused node data for both renderers", async () => {
    mocks.listForeignKeys.mockResolvedValueOnce([{ name: "fk", column: "id", ref_table: "A", ref_schema: "other", ref_column: "id" }]);
    mocks.listForeignKeys.mockResolvedValueOnce([]);
    const { state } = await mountDialog();
    expect(state.nodes.find((node: any) => node.id === "public.A").data.isFocused).toBe(true);
    expect(state.nodes.find((node: any) => node.id === "other.A").data.isFocused).toBe(false);
    expect([...state.focusedNodeIds]).toEqual(["public.A"]);
    expect(state.engineeringDiagram.entities.map((entity: any) => entity.name).sort()).toEqual(["other.A", "public.A"]);
  });

  it("handles Ctrl-wheel once at the pointer and leaves ordinary scrolling to Vue Flow", async () => {
    const { state } = await mountDialog();
    const pane = document.createElement("div");
    state.diagramPaneRef = pane;
    const plain = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    state.handleDiagramWheel(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(mocks.setViewport).not.toHaveBeenCalled();
    // happy-dom's WheelEvent inherits UIEvent and omits MouseEvent coordinates/modifiers.
    const ctrl = new MouseEvent("wheel", { ctrlKey: true, clientX: 200, clientY: 100, cancelable: true });
    Object.defineProperties(ctrl, { deltaY: { value: -100 }, deltaMode: { value: 0 } });
    const stop = vi.spyOn(ctrl, "stopPropagation");
    state.handleDiagramWheel(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.setViewport).toHaveBeenCalledOnce();
    const viewport = mocks.setViewport.mock.calls[0][0];
    expect(viewport.zoom).toBeGreaterThan(1);
    expect((200 - viewport.x) / viewport.zoom).toBeCloseTo(200);
    expect((100 - viewport.y) / viewport.zoom).toBeCloseTo(100);
  });

  it("loads the recursive closure without listing tables and passes catalog", async () => {
    const { state } = await mountDialog();
    expect(state.tables.map((table: DiagramTable) => table.name)).toEqual(["A", "B", "C"]);
    expect(state.visibleTables).toHaveLength(3);
    expect(state.nodes.find((node: any) => node.id === "A").data.relationships).toEqual([expect.objectContaining({ sourceTable: "A", targetTable: "B" })]);
    expect(state.nodes.find((node: any) => node.id === "C").data.relationships).toEqual([expect.objectContaining({ sourceTable: "B", targetTable: "C" })]);
    expect(mocks.listTables).not.toHaveBeenCalled();
    expect(mocks.getColumns).toHaveBeenCalledWith("c", "db", "public", "C", "catalog");
    expect(mocks.listForeignKeys).toHaveBeenCalledTimes(3);
    expect(mocks.listForeignKeysForDatabase).not.toHaveBeenCalled();
    expect(state.loadingDiagram).toBe(false);
  });

  it("reopens from cache without any remote metadata or connection requests", async () => {
    await mountDialog();
    vi.clearAllMocks();
    const { state } = await mountDialog();
    expect(state.tables).toHaveLength(3);
    expect(state.loadedTableCount).toBe(3);
    expect(state.totalTableCount).toBe(3);
    expect(state.loadingDiagram).toBe(false);
    for (const method of [mocks.getColumns, mocks.listForeignKeys, mocks.listIndexes, mocks.getTableComment, mocks.listTables, mocks.listDatabases, mocks.listSchemas, mocks.ensureConnected]) expect(method).not.toHaveBeenCalled();
  });

  it("retains full-schema loading when opened without a root", async () => {
    const { state } = await mountDialog(false);
    expect(mocks.listTables).toHaveBeenCalledTimes(1);
    expect(state.tables).toHaveLength(4);
  });

  it("loads a deduplicated union of multiple roots", async () => {
    const { state } = await mountDialog(true, { focusTableNames: ["A", "B", "unrelated"] });
    expect(state.tables.map((table: DiagramTable) => table.name)).toEqual(["A", "B", "C", "unrelated"]);
    expect(mocks.getColumns).toHaveBeenCalledTimes(4);
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("reuses cached default-schema roots when no schema was prefilled", async () => {
    await mountDialog(true, { prefillSchema: undefined });
    vi.clearAllMocks();
    expect((await mountDialog(true, { prefillSchema: undefined })).state.tables).toHaveLength(3);
    expect(mocks.listSchemas).not.toHaveBeenCalled();
    expect(mocks.getColumns).not.toHaveBeenCalled();
  });

  it("initial metadata failure leaves an empty diagram and retries without a partial cache", async () => {
    mocks.listIndexes.mockRejectedValueOnce(new Error("indexes offline"));
    const { state } = await mountDialog();
    expect(state.tables).toEqual([]);
    expect(state.loadingDiagram).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("indexes offline", 5000);
    vi.clearAllMocks();
    expect((await mountDialog()).state.tables).toHaveLength(3);
    expect(mocks.getColumns).toHaveBeenCalledTimes(3);
  });

  it("Show all tables loads full metadata and switching back reuses the focused cache", async () => {
    const { state } = await mountDialog();
    await state.handleToggleShowAllTables();
    expect(state.showAllTables).toBe(true);
    expect(state.tables).toHaveLength(4);
    expect(mocks.listTables).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await state.handleToggleShowAllTables();
    expect(state.showAllTables).toBe(false);
    expect(state.tables).toHaveLength(3);
    expect(mocks.getColumns).not.toHaveBeenCalled();
  });

  it("confirmation bypasses cache while failure keeps the previous diagram and cache", async () => {
    const { state } = await mountDialog();
    const oldTables = state.tables;
    const pending = deferred<never>();
    mocks.listForeignKeys.mockImplementationOnce(() => pending.promise);
    state.requestRefreshDiagram();
    expect(state.showRefreshConfirm).toBe(true);
    state.confirmRefreshDiagram();
    await settle();
    expect(state.tables).toBe(oldTables);
    expect(state.loadingDiagram).toBe(true);
    pending.reject(new Error("offline"));
    await settle();
    expect(state.tables).toBe(oldTables);
    expect(state.loadingDiagram).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("offline", 5000);
    vi.clearAllMocks();
    const reopened = await mountDialog();
    expect(reopened.state.tables).toHaveLength(3);
    expect(mocks.getColumns).not.toHaveBeenCalled();
  });

  it("successful refresh replaces the cached closure", async () => {
    const { state } = await mountDialog();
    mocks.listForeignKeys.mockResolvedValueOnce([]);
    state.confirmRefreshDiagram();
    await settle();
    expect(state.tables.map((table: DiagramTable) => table.name)).toEqual(["A"]);
    vi.clearAllMocks();
    expect((await mountDialog()).state.tables).toHaveLength(1);
    expect(mocks.getColumns).not.toHaveBeenCalled();
  });

  it("refresh fetches and applies the latest columns, indexes, and foreign keys before replacing the cache", async () => {
    const { state } = await mountDialog();
    vi.clearAllMocks();
    const refreshedColumns: ColumnInfo[] = [
      { name: "id", data_type: "int", is_nullable: false, is_primary_key: true, column_default: null, extra: null },
      { name: "refreshed_column", data_type: "text", is_nullable: true, is_primary_key: false, column_default: null, extra: null },
    ];
    const refreshedIndexes: IndexInfo[] = [{ name: "ux_refreshed", columns: ["refreshed_column"], is_unique: true, is_primary: false }];
    const refreshedForeignKeys: ForeignKeyInfo[] = [{ name: "fk_refreshed", column: "id", ref_table: "D", ref_column: "id" }];
    mocks.getColumns.mockResolvedValueOnce(refreshedColumns);
    mocks.listIndexes.mockResolvedValueOnce(refreshedIndexes);
    mocks.listForeignKeys.mockResolvedValueOnce(refreshedForeignKeys);

    state.confirmRefreshDiagram();
    await settle();

    expect(mocks.getColumns).toHaveBeenCalledWith("c", "db", "public", "A", "catalog");
    expect(mocks.listIndexes).toHaveBeenCalledWith("c", "db", "public", "A", "catalog");
    expect(mocks.listForeignKeys).toHaveBeenCalledWith("c", "db", "public", "A", "catalog");
    expect(mocks.listForeignKeysForDatabase).not.toHaveBeenCalled();
    const refreshedRoot = state.tables.find((table: DiagramTable) => table.name === "A") as DiagramTable;
    expect(refreshedRoot.columns.map((column) => column.name)).toEqual(["id", "refreshed_column"]);
    expect(refreshedRoot.indexes?.map((index) => index.name)).toEqual(["ux_refreshed"]);
    expect(refreshedRoot.foreignKeys).toEqual(refreshedForeignKeys);
    expect(state.visibleRelationships).toEqual([expect.objectContaining({ name: "fk_refreshed", sourceTable: "A", targetTable: "D" })]);

    vi.clearAllMocks();
    const reopened = await mountDialog();
    const cachedRoot = reopened.state.tables.find((table: DiagramTable) => table.name === "A") as DiagramTable;
    expect(cachedRoot.columns.map((column) => column.name)).toEqual(["id", "refreshed_column"]);
    expect(cachedRoot.indexes?.map((index) => index.name)).toEqual(["ux_refreshed"]);
    expect(cachedRoot.foreignKeys).toEqual(refreshedForeignKeys);
    for (const method of [mocks.getColumns, mocks.listIndexes, mocks.listForeignKeys, mocks.listForeignKeysForDatabase]) expect(method).not.toHaveBeenCalled();
  });

  it("qualifies same-name nodes from different schemas", async () => {
    mocks.listForeignKeys.mockResolvedValueOnce([{ name: "fk", column: "id", ref_table: "A", ref_schema: "other", ref_column: "id" }]);
    mocks.listForeignKeys.mockResolvedValueOnce([]);
    const { state } = await mountDialog();
    expect(state.isMultiSchema).toBe(true);
    expect(state.tables.map((table: DiagramTable) => state.getTableKey(table))).toEqual(["other.A", "public.A"]);
    expect(state.visibleRelationships[0]).toMatchObject({ sourceTable: "public.A", targetTable: "other.A" });
    expect(state.positions["public.A"]).toBeDefined();
    expect(state.positions["other.A"]).toBeDefined();
    expect(state.positions["public.A"]).not.toEqual(state.positions["other.A"]);
  });

  it("a late response cannot replace a newer schema result or its loading state", async () => {
    const { state } = await mountDialog();
    const pending = deferred<never[]>();
    mocks.getColumns.mockImplementationOnce(() => pending.promise);
    const old = state.loadDiagram({ force: true });
    await settle();
    await state.setSchema("other");
    expect(state.tables.every((table: DiagramTable) => table.schema === "other")).toBe(true);
    const current = state.tables;
    pending.resolve([]);
    await old;
    expect(state.tables).toBe(current);
    expect(state.loadingDiagram).toBe(false);
  });

  it("ignores a pending result after closing the dialog", async () => {
    const { state } = await mountDialog();
    const pending = deferred<never[]>();
    mocks.getColumns.mockImplementationOnce(() => pending.promise);
    const load = state.loadDiagram({ force: true });
    await settle();
    state.open = false;
    await settle();
    const old = state.tables;
    pending.resolve([]);
    await load;
    expect(state.tables).toBe(old);
    expect(state.loadingDiagram).toBe(false);
  });

  it("opening, dragging, editing, and refreshing preserves unrelated persisted data", async () => {
    const draft: DiagramTable = { name: "draft_elsewhere", schema: "public", origin: "draft", columns: [], foreignKeys: [] };
    saveDraftTables([draft], "c", "db", "public");
    saveLiveTablePatches([{ ...draft, name: "unrelated", origin: "live", pendingDrop: true }], "c", "db", "public");
    savePersistedPositions({ unrelated: { x: 900, y: 800 } }, "c", "db", "public");
    savePersistedLayers([{ id: "layer", name: "saved", color: "red", visible: true, collapsed: false, tableNames: ["unrelated"] }], "c", "db", "public");
    const { state } = await mountDialog();
    await state.handleNodeDragStop({ node: { id: "A", type: "table", position: { x: 12, y: 34 } } });
    const root = state.tables.find((table: DiagramTable) => table.name === "A") as DiagramTable;
    const pendingColumn: ColumnInfo = { name: "pending_note", data_type: "text", is_nullable: true, is_primary_key: false, column_default: null, extra: null };
    state.handleInspectorUpdateTable({ ...root, columns: [...root.columns, pendingColumn], pendingColumnNames: [pendingColumn.name] });
    await state.loadDiagram({ force: true });
    expect(loadPersistedPositions("c", "db", "public").A).toEqual({ x: 12, y: 34 });
    expect(
      loadLiveTablePatches("c", "db", "public")
        .find((patch) => patch.tableName === "A")
        ?.pendingColumns.map((column) => column.name),
    ).toEqual(["pending_note"]);
    expect(loadDraftTables("c", "db", "public").map((table) => table.name)).toContain("draft_elsewhere");
    expect(loadLiveTablePatches("c", "db", "public").find((patch) => patch.tableName === "unrelated")?.pendingDrop).toBe(true);
    expect(loadPersistedPositions("c", "db", "public").unrelated).toEqual({ x: 900, y: 800 });
    expect(loadPersistedLayers("c", "db", "public")[0].tableNames).toContain("unrelated");
  });
});
