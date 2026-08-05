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
  getConfig: () => ({ id: "connection-1", db_type: "sqlserver" }),
  isDefaultDatabase: () => false,
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

const settingsStore = {
  editorSettings: {
    shortcuts: { openDataInNewTab: "" },
    sidebarActivation: "double" as "single" | "double",
    sidebarAllowHorizontalScroll: false,
    sidebarHiddenTablePrefixes: [],
    sidebarObjectInfoMode: "none",
  },
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => settingsStore,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

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
  const host = runtimeHost();
  runtime.bindHost(host);
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 2 }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Tree item row was not rendered: ${container.innerHTML}`);
  return { row, host };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.selectedTreeNodeId = null;
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.selectedTreeNodeIdsSet = new Set<string>();
  connectionStore.treeSelectionAnchorId = null;
  settingsStore.editorSettings.sidebarActivation = "double";
  vi.restoreAllMocks();
});

describe("TreeItem load-more activation", () => {
  it("runs load-more on a single click in double-click activation mode", async () => {
    const node: TreeNode = {
      id: "connection-1:app:dbo:__procedures:__load_more:200",
      label: "tree.loadMore",
      type: "load-more",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
      loadMore: {
        parentId: "connection-1:app:dbo:__procedures",
        offset: 200,
        pageSize: 200,
      },
    };
    const { row, host } = await mountTreeItem(node);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(host.handleRowClick).toHaveBeenCalledWith(node, 1);
  });

  it("keeps regular rows selection-only on a single click", async () => {
    const node: TreeNode = {
      id: "connection-1:app:dbo:orders",
      label: "orders",
      type: "table",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
    };
    const { row, host } = await mountTreeItem(node);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(host.handleRowClick).not.toHaveBeenCalled();
  });
});
