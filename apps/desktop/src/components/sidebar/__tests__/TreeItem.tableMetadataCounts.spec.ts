// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "connection-1", db_type: "postgres" }),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
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

describe("TreeItem table metadata counts", () => {
  it("renders counts for loaded table metadata groups, including empty groups", async () => {
    const groups = [
      ["group-columns", "tree.columns", 2],
      ["group-indexes", "tree.indexes", 1],
      ["group-fkeys", "tree.foreignKeys", 3],
      ["group-triggers", "tree.triggers", 0],
      ["group-constraints", "tree.constraints", 4],
      ["group-table-partitions", "tree.partitions", 5],
      ["group-table-subpartitions", "tree.subpartitions", 6],
    ] as const;

    for (const [type, label, objectCount] of groups) {
      const container = await mountTreeItem({
        id: `connection-1:app:orders:${type}`,
        label,
        type,
        connectionId: "connection-1",
        database: "app",
        tableName: "orders",
        objectCount,
        children: [],
      });
      expect(container.textContent).toContain(String(objectCount));
    }
  });
});
