// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, provide, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TreeNode } from "@/types/database";
import { flattenTree } from "@/composables/useFlatTree";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
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
  getEtcdAccessCapabilities: vi.fn(() => ({ admin: true, writable: true, writePermissions: null })),
  ensureConnected: vi.fn(async () => undefined),
  loadPackageMembers: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
  loadObjectGroupChildren: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
  loadXuguTablespaces: vi.fn(async (node: TreeNode) => {
    node.isExpanded = true;
  }),
};

const queryStore = {
  createTab: vi.fn(),
  openNacosAdmin: vi.fn(),
};

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "connection attempt cancelled",
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { sidebarActivation: "single" } }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({}) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: vi.fn() }) }));
vi.mock("@/composables/useSidebarDataOpenRuntime", () => ({ useSidebarDataOpenRuntime: () => ({ openData: vi.fn() }) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ useDatabaseOptions: () => ({ getDatabaseOptions: vi.fn() }) }));
vi.mock("@/composables/useSidebarConnectionMutationRuntime", () => ({ useSidebarConnectionMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarDatabaseSpecificMutationRuntime", () => ({ useSidebarDatabaseSpecificMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTableMutationRuntime", () => ({ useSidebarTableMutationRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeExportRuntime", () => ({ useSidebarTreeExportRuntime: () => ({}) }));
vi.mock("@/composables/useSidebarTreeToolRuntime", () => ({ useSidebarTreeToolRuntime: () => ({}) }));

function buildTree(): TreeNode[] {
  return [
    {
      id: "conn",
      label: "conn",
      type: "connection",
      connectionId: "mysql",
      isExpanded: true,
      children: [
        {
          id: "tables",
          label: "tree.tables",
          type: "group-tables",
          connectionId: "mysql",
          database: "basic",
          isExpanded: true,
          children: [
            { id: "t1", label: "t1", type: "table", connectionId: "mysql", database: "basic" },
            { id: "t2", label: "t2", type: "table", connectionId: "mysql", database: "basic" },
          ],
        },
      ],
    },
  ];
}

function arrowEvent(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

function selectNode(nodeId: string): void {
  connectionStore.selectedTreeNodeId = nodeId;
  connectionStore.selectedTreeNodeIds = [nodeId];
  connectionStore.treeSelectionAnchorId = nodeId;
}

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.treeNodes = [];
  connectionStore.sidebarSearchQuery = "";
  connectionStore.activeConnectionId = null;
  connectionStore.connectedIds.clear();
  connectionStore.selectedTreeNodeId = null;
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.treeSelectionAnchorId = null;
  connectionStore.connectionMultiSelectActive = false;
  vi.clearAllMocks();
  connectionStore.canUseLoadedTreeNodeToggle.mockReturnValue(true);
  connectionStore.getConfig.mockReturnValue({ db_type: "mysql", name: "connection" });
  connectionStore.getEtcdAccessCapabilities.mockReturnValue({ admin: true, writable: true, writePermissions: null });
});

describe("SidebarTreeRuntimeHost arrow navigation", () => {
  it("ArrowDown moves the selection to the next row and focuses it", async () => {
    const tree = buildTree();
    connectionStore.treeNodes = tree;
    connectionStore.connectedIds.add("mysql");
    selectNode("t1");
    const focusTreeNode = vi.fn();

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => flattenTree(tree).map((row) => row.node),
            getVisibleNodeIndex: () => 0,
            getVisibleFlatNodes: () => flattenTree(tree),
            focusTreeNode,
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: tree[0]!.children![0]!.children![0]!, depth: 3 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    const event = arrowEvent("ArrowDown");
    host.value?.handleRowKeydown(tree[0]!.children![0]!.children![0]!, event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(connectionStore.selectedTreeNodeId).toBe("t2");
    expect(connectionStore.selectedTreeNodeIds).toEqual(["t2"]);
    expect(connectionStore.treeSelectionAnchorId).toBe("t2");
    expect(connectionStore.connectionMultiSelectActive).toBe(false);
    expect(focusTreeNode).toHaveBeenCalledWith("t2");
  });

  it("ArrowRight expands a collapsed cached group without moving the selection", async () => {
    const tree = buildTree();
    const group = tree[0]!.children![0]!;
    group.isExpanded = false;
    connectionStore.treeNodes = tree;
    connectionStore.connectedIds.add("mysql");
    connectionStore.activeConnectionId = "mysql";
    selectNode("tables");

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => [group],
            getVisibleNodeIndex: () => 0,
            getVisibleFlatNodes: () => flattenTree(tree),
            focusTreeNode: vi.fn(),
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: group, depth: 2 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    const event = arrowEvent("ArrowRight");
    host.value?.handleRowKeydown(group, event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(group.isExpanded).toBe(true);
    expect(connectionStore.selectedTreeNodeId).toBe("tables");
    expect(connectionStore.loadObjectGroupChildren).not.toHaveBeenCalled();
  });

  it("arrow keys do nothing without a context providing visible flat nodes", async () => {
    const tree = buildTree();
    connectionStore.treeNodes = tree;
    selectNode("t1");

    const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
    const app = createApp(
      defineComponent({
        setup() {
          provide(sidebarTreeContextKey, {
            getVisibleNodes: () => flattenTree(tree).map((row) => row.node),
            getVisibleNodeIndex: () => 0,
          });
          return () => h(SidebarTreeRuntimeHost, { ref: host, node: tree[0]!.children![0]!.children![0]!, depth: 3 });
        },
      }),
    );
    mountedApps.push(app);
    const container = document.createElement("div");
    document.body.append(container);
    app.use(i18n);
    app.mount(container);

    const event = arrowEvent("ArrowDown");
    host.value?.handleRowKeydown(tree[0]!.children![0]!.children![0]!, event);
    await nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(connectionStore.selectedTreeNodeId).toBe("t1");
  });
});
