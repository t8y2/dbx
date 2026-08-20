// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { filterSidebarTree, filterSidebarTreeToConnectedConnections } from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import type { SidebarLayout, TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [] as { id: string }[],
  expandConnectionGroups: vi.fn(),
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
  sidebarLayout: { groups: [], order: [] } as SidebarLayout,
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

async function mountTreeItem(node: TreeNode, options: { projectedConnectionIds?: ReadonlySet<string> | null } = {}) {
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
  if (options.projectedConnectionIds !== undefined) {
    app.provide(sidebarTreeContextKey, {
      getVisibleNodes: () => [node],
      getVisibleNodeIndex: (id) => (id === node.id ? 0 : -1),
      getProjectedConnectionIds: () => options.projectedConnectionIds ?? null,
    });
  }
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Tree item row was not rendered: ${container.innerHTML}`);
  return { row, host };
}

function connectionIdsInProjection(nodes: readonly TreeNode[]): Set<string> {
  const connectionIds = new Set<string>();
  const visit = (currentNodes: readonly TreeNode[]) => {
    for (const node of currentNodes) {
      if (node.type === "connection" && node.connectionId) connectionIds.add(node.connectionId);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(nodes);
  return connectionIds;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  connectionStore.selectedTreeNodeId = null;
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.selectedTreeNodeIdsSet = new Set<string>();
  connectionStore.connectionMultiSelectActive = false;
  // 重置测试中修改的连接列表，避免残留数据影响后续用例的选择过滤
  connectionStore.connections = [];
  // 清空分组展开的调用记录，避免上一个用例的调用历史污染断言
  connectionStore.expandConnectionGroups.mockClear();
  connectionStore.sidebarLayout = { groups: [], order: [] };
  connectionStore.treeNodes = [];
  connectionStore.treeSelectionAnchorId = null;
  settingsStore.editorSettings.sidebarActivation = "double";
  vi.restoreAllMocks();
});

describe("TreeItem load-more activation", () => {
  it("cascades a connection group checkbox to its connections", async () => {
    const group: TreeNode = {
      id: "group-1",
      label: "Group 1",
      type: "connection-group",
      children: [],
    };
    connectionStore.treeNodes = [group];
    // 分组下挂一个连接，勾选框会级联选中该连接
    connectionStore.sidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [{ type: "group", id: group.id, children: [{ type: "connection", id: "connection-2" }] }],
    };
    connectionStore.connections = [{ id: "connection-2" }];
    const { row } = await mountTreeItem(group);
    const toggle = row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]');
    expect(toggle).not.toBeNull();

    toggle?.click();

    // 勾选后级联选中分组下的连接，并自动展开该分组
    expect(connectionStore.selectedTreeNodeIds).toEqual(["connection-2"]);
    expect(connectionStore.selectedTreeNodeId).toBe("connection-2");
    expect(connectionStore.treeSelectionAnchorId).toBe("connection-2");
    expect(connectionStore.connectionMultiSelectActive).toBe(true);
    expect(connectionStore.expandConnectionGroups).toHaveBeenCalledWith([group.id]);

    toggle?.click();

    // 再次点击取消勾选分组下的全部连接
    expect(connectionStore.selectedTreeNodeIds).toEqual([]);
    expect(connectionStore.selectedTreeNodeId).toBeNull();
    expect(connectionStore.treeSelectionAnchorId).toBeNull();
    expect(connectionStore.connectionMultiSelectActive).toBe(false);
  });

  it("ignores the checkbox of an empty connection group", async () => {
    const group: TreeNode = {
      id: "group-1",
      label: "Group 1",
      type: "connection-group",
      children: [],
    };
    connectionStore.treeNodes = [group];
    connectionStore.sidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [{ type: "group", id: group.id, children: [] }],
    };
    const { row } = await mountTreeItem(group);
    const toggle = row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]');
    expect(toggle).not.toBeNull();

    toggle?.click();

    // 空分组没有可级联的连接，点击不产生任何选择变化
    expect(connectionStore.selectedTreeNodeIds).toEqual([]);
    expect(connectionStore.connectionMultiSelectActive).toBe(false);
    expect(connectionStore.expandConnectionGroups).not.toHaveBeenCalled();
  });

  it("limits a searched group cascade to connections in the current projection", async () => {
    const firstConnection: TreeNode = {
      id: "connection-1",
      label: "Alpha",
      type: "connection",
      connectionId: "connection-1",
    };
    const secondConnection: TreeNode = {
      id: "connection-2",
      label: "Beta",
      type: "connection",
      connectionId: "connection-2",
    };
    const group: TreeNode = {
      id: "group-1",
      label: "Group 1",
      type: "connection-group",
      isExpanded: true,
      children: [firstConnection, secondConnection],
    };
    connectionStore.treeNodes = [group];
    connectionStore.sidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [
        {
          type: "group",
          id: group.id,
          children: [
            { type: "connection", id: firstConnection.id },
            { type: "connection", id: secondConnection.id },
          ],
        },
      ],
    };
    connectionStore.connections = [{ id: firstConnection.id }, { id: secondConnection.id }];
    const projection = connectionIdsInProjection(filterSidebarTree([group], "alpha", new Set()));
    const { row } = await mountTreeItem(group, { projectedConnectionIds: projection });

    row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]')?.click();

    expect(connectionStore.selectedTreeNodeIds).toEqual([firstConnection.id]);
    expect(connectionStore.selectedTreeNodeIds).not.toContain(secondConnection.id);
  });

  it("limits a connected-only group cascade to connected connections", async () => {
    const connected: TreeNode = {
      id: "connection-1",
      label: "Connected",
      type: "connection",
      connectionId: "connection-1",
    };
    const disconnected: TreeNode = {
      id: "connection-2",
      label: "Disconnected",
      type: "connection",
      connectionId: "connection-2",
    };
    const group: TreeNode = {
      id: "group-1",
      label: "Group 1",
      type: "connection-group",
      isExpanded: true,
      children: [connected, disconnected],
    };
    connectionStore.treeNodes = [group];
    connectionStore.sidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [
        {
          type: "group",
          id: group.id,
          children: [
            { type: "connection", id: connected.id },
            { type: "connection", id: disconnected.id },
          ],
        },
      ],
    };
    connectionStore.connections = [{ id: connected.id }, { id: disconnected.id }];
    const projection = connectionIdsInProjection(filterSidebarTreeToConnectedConnections([group], new Set([connected.id])));
    const { row } = await mountTreeItem(group, { projectedConnectionIds: projection });

    row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]')?.click();

    expect(connectionStore.selectedTreeNodeIds).toEqual([connected.id]);
    expect(connectionStore.selectedTreeNodeIds).not.toContain(disconnected.id);
  });

  it("exposes none, mixed, and all group selection states", async () => {
    const group: TreeNode = {
      id: "group-1",
      label: "Group 1",
      type: "connection-group",
    };
    connectionStore.sidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [
        {
          type: "group",
          id: group.id,
          children: [
            { type: "connection", id: "connection-1" },
            { type: "connection", id: "connection-2" },
          ],
        },
      ],
    };

    const none = (await mountTreeItem(group)).row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]');
    expect(none?.getAttribute("role")).toBe("checkbox");
    expect(none?.getAttribute("aria-checked")).toBe("false");
    expect(none?.getAttribute("aria-label")).toBe(i18n.global.t("connectionGroup.selectGroup"));

    connectionStore.selectedTreeNodeIdsSet = new Set(["connection-1"]);
    const mixed = (await mountTreeItem(group)).row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]');
    expect(mixed?.getAttribute("aria-checked")).toBe("mixed");
    expect(mixed?.getAttribute("aria-label")).toBe(i18n.global.t("connectionGroup.selectGroup"));

    connectionStore.selectedTreeNodeIdsSet = new Set(["connection-1", "connection-2"]);
    const all = (await mountTreeItem(group)).row.querySelector<HTMLButtonElement>('[data-sidebar-group-selection-toggle="true"]');
    expect(all?.getAttribute("aria-checked")).toBe("true");
    expect(all?.getAttribute("aria-label")).toBe(i18n.global.t("connectionGroup.deselectGroup"));
  });

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

describe("TreeItem object counts", () => {
  it("renders the event group count", async () => {
    const node: TreeNode = {
      id: "connection-1:app:__events",
      label: "tree.events",
      type: "group-events",
      connectionId: "connection-1",
      database: "app",
      objectCount: 17,
      children: [],
    };

    const { row } = await mountTreeItem(node);

    expect(row.textContent).toContain("17");
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
