// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const filterState = {
  includePatterns: ["vw_%"],
  excludePatterns: [],
};

const connectionStore = {
  activeConnectionId: "hana-1",
  connectedIds: new Set(["hana-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "hana-1", db_type: "saphana" }),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: vi.fn((_scope: any) => filterState),
  treeNodes: [],
  treeSelectionAnchorId: null as string | null,
};

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { openDataInNewTab: "" },
      sidebarActivation: "double",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
    },
  }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const mountedApps: App[] = [];

function runtimeHost(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

async function mountTreeItem(node: TreeNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  const app = createApp(defineComponent({ setup: () => () => h(TreeItem, { node, depth: 2 }) }));
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("TreeItem empty database filter badge", () => {
  it("renders active filter indicator for catalogless group node with empty database", async () => {
    const node: TreeNode = {
      id: "hana-1:::SYS:group-views",
      label: "tree.views",
      type: "group-views",
      connectionId: "hana-1",
      database: "",
      schema: "SYS",
      objectCount: 12,
      children: [],
    };

    const container = await mountTreeItem(node);
    expect(connectionStore.tableNameFilterForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "hana-1",
        database: "",
        schema: "SYS",
        nodeKind: "group-views",
      }),
    );
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("filtered");
  });
});
