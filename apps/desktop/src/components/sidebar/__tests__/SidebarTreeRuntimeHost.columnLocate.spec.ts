// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";

const connectionStore = {
  treeNodes: [] as TreeNode[],
  sidebarSearchQuery: "",
  activeConnectionId: null as string | null,
  connectedIds: new Set<string>(),
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  treeSelectionAnchorId: null as string | null,
  connectionMultiSelectActive: false,
  get selectedTreeNodeIdsSet(): Set<string> {
    return new Set(this.selectedTreeNodeIds);
  },
  canUseLoadedTreeNodeToggle: vi.fn(() => true),
  releaseCollapsedTreeNodeChildren: vi.fn(),
  getConfig: vi.fn(() => ({ db_type: "mysql", name: "connection" })),
  ensureConnected: vi.fn(async () => undefined),
};

const queryStore = {
  tabs: [] as any[],
  switchTab: vi.fn(),
  createTab: vi.fn(),
};

const settings = {
  sidebarActivation: "single",
  sidebarBrowseObjectsOnDatabaseActivation: false,
  dataTabReuseMode: "same-table",
  shortcuts: { openDataInNewTab: "" },
};

const openDataMock = vi.fn();
const openStructureEditorMock = vi.fn();

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "connection attempt cancelled",
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: settings }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: openDataMock }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({ useSidebarDatabaseSpecificMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({ openStructureEditor: openStructureEditorMock }) }));

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  openDataMock.mockReset();
  openStructureEditorMock.mockReset();
  vi.clearAllMocks();
});

describe("SidebarTreeRuntimeHost column locate", () => {
  it("locates column in data grid on single click in single-activation mode", async () => {
    settings.sidebarActivation = "single";

    const tableNode: TreeNode = {
      id: "mysql:app:users",
      label: "users",
      type: "table",
      connectionId: "mysql",
      database: "app",
      isExpanded: true,
      children: [],
    };
    const columnNode: TreeNode = {
      id: "mysql:app:users:__columns:email",
      label: "email (varchar(255))",
      type: "column",
      connectionId: "mysql",
      database: "app",
      tableName: "users",
      meta: { name: "email", data_type: "varchar(255)" },
    };
    tableNode.children = [columnNode];
    connectionStore.treeNodes = [tableNode];

    const onOpenData = vi.fn(async (target, requireSelection, openMode, runner) => {
      await runner(target, { isCurrent: () => true, signal: new AbortController().signal, registerCancel: vi.fn() });
    });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const container = document.createElement("div");
    document.body.appendChild(container);

    const app = createApp(
      defineComponent({
        setup() {
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: columnNode, depth: 1, onOpenData });
        },
      }),
    );
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    host.value?.handleRowClick(columnNode, 1);
    await nextTick();

    expect(onOpenData).toHaveBeenCalledWith(expect.objectContaining({ label: "users", connectionId: "mysql", database: "app" }), false, "default", expect.any(Function));
    expect(openDataMock).toHaveBeenCalledWith(expect.objectContaining({ label: "users" }), expect.anything(), "default", { revealColumn: "email" });
  });

  it("opens the structure editor for a double-clicked column", async () => {
    settings.sidebarActivation = "double";

    const tableNode: TreeNode = {
      id: "mysql:app:users",
      label: "users",
      type: "table",
      connectionId: "mysql",
      database: "app",
      isExpanded: true,
      children: [],
    };
    const columnNode: TreeNode = {
      id: "mysql:app:users:__columns:age",
      label: "age (int)",
      type: "column",
      connectionId: "mysql",
      database: "app",
      tableName: "users",
      meta: { name: "age", data_type: "int" },
    };
    tableNode.children = [columnNode];
    connectionStore.treeNodes = [tableNode];

    const onOpenData = vi.fn(async (target, requireSelection, openMode, runner) => {
      await runner(target, { isCurrent: () => true, signal: new AbortController().signal, registerCancel: vi.fn() });
    });

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const container = document.createElement("div");
    document.body.appendChild(container);

    const app = createApp(
      defineComponent({
        setup() {
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: columnNode, depth: 1, onOpenData });
        },
      }),
    );
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    host.value?.handleRowDoubleClick(columnNode, new MouseEvent("dblclick"));
    await nextTick();

    expect(onOpenData).not.toHaveBeenCalled();
    expect(openDataMock).not.toHaveBeenCalled();
    expect(openStructureEditorMock).toHaveBeenCalledTimes(1);
  });
});
