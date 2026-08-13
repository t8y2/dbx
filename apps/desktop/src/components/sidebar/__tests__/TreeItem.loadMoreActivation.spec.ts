// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => ({ id: "connection-1", db_type: "sqlserver" }),
  getSidebarVisibleFilterSummary: () => null,
  clearConnectionError: vi.fn(),
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
  connectionStore.treeNodes = [];
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

  it("drops a selected object group when modifier-selecting a real table", async () => {
    const group: TreeNode = {
      id: "connection-1:app:dbo:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
    };
    const table: TreeNode = {
      id: "connection-1:app:dbo:orders",
      label: "orders",
      type: "table",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
    };
    connectionStore.treeNodes = [{ ...group, children: [table] }];
    connectionStore.selectedTreeNodeId = group.id;
    connectionStore.selectedTreeNodeIds = [group.id];
    connectionStore.selectedTreeNodeIdsSet = new Set([group.id]);
    connectionStore.treeSelectionAnchorId = group.id;
    const { row } = await mountTreeItem(table);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, metaKey: true }));

    expect(connectionStore.selectedTreeNodeIds).toEqual([table.id]);
    expect(connectionStore.selectedTreeNodeId).toBe(table.id);
    expect(connectionStore.treeSelectionAnchorId).toBe(table.id);
  });

  it("shows the invalid marker for objects reported as invalid", async () => {
    const node: TreeNode = {
      id: "connection-1:app:dbo:broken_proc",
      label: "broken_proc",
      type: "procedure",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
      valid: false,
    };
    const { row } = await mountTreeItem(node);

    expect(row.textContent).toContain("broken_proc · INVALID");
    expect(row.querySelector('[data-invalid-object-indicator="true"]')).not.toBeNull();
  });

  it("does not show the invalid marker for valid or unknown-status objects", async () => {
    const validNode: TreeNode = {
      id: "connection-1:app:dbo:healthy_proc",
      label: "healthy_proc",
      type: "procedure",
      connectionId: "connection-1",
      database: "app",
      schema: "dbo",
      valid: true,
    };
    const unknownNode: TreeNode = {
      ...validNode,
      id: "connection-1:app:dbo:unknown_proc",
      label: "unknown_proc",
      valid: null,
    };

    const valid = await mountTreeItem(validNode);
    expect(valid.row.textContent).not.toContain("INVALID");
    expect(valid.row.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();

    const unknown = await mountTreeItem(unknownNode);
    expect(unknown.row.textContent).not.toContain("INVALID");
    expect(unknown.row.querySelector('[data-invalid-object-indicator="true"]')).toBeNull();
  });
});

describe("TreeItem searched connection activation", () => {
  function searchedConnection(): TreeNode {
    const filtered = filterSidebarTree(
      [
        {
          id: "connection-1",
          label: "1000",
          type: "connection",
          connectionId: "connection-1",
          isExpanded: false,
          children: [
            {
              id: "connection-1:__user_admin",
              label: "tree.userAdmin",
              type: "user-admin",
              connectionId: "connection-1",
              database: "",
            },
          ],
        },
      ],
      "1000",
      new Set(),
    )[0];
    if (!filtered) throw new Error("Expected the matching connection search result");
    return filtered;
  }

  it("activates a connection search result on one click in single-click mode", async () => {
    settingsStore.editorSettings.sidebarActivation = "single";
    const node = searchedConnection();
    const { row, host } = await mountTreeItem(node);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(node.children).toEqual([]);
    expect(node.isExpanded).toBe(false);
    expect(host.handleRowClick).toHaveBeenCalledWith(node, 1);
    expect(host.handleRowDoubleClick).not.toHaveBeenCalled();
  });

  it("waits for a double click before activating a connection search result in double-click mode", async () => {
    settingsStore.editorSettings.sidebarActivation = "double";
    const node = searchedConnection();
    const { row, host } = await mountTreeItem(node);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(host.handleRowClick).not.toHaveBeenCalled();

    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    expect(host.handleRowDoubleClick).toHaveBeenCalledWith(node, expect.any(MouseEvent));
  });
});
