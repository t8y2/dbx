// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const endpointConnection: ConnectionConfig = {
  id: "connection-1",
  name: "Orders",
  db_type: "postgres",
  host: "192.168.1.10",
  port: 5432,
  username: "postgres",
  password: "",
};

let connection: ConnectionConfig = endpointConnection;

const editorSettings = {
  shortcuts: { openDataInNewTab: "" },
  sidebarActivation: "double",
  sidebarAllowHorizontalScroll: false,
  sidebarHiddenTablePrefixes: [],
  sidebarObjectInfoMode: "comment-inline",
  sidebarShowConnectionEndpoints: false,
  sidebarShowConnectionNotes: false,
  sidebarDensity: "default",
  sidebarShowTooltips: false,
  sidebarIndent: 16,
  sidebarTableSearchLocal: true,
};

const connectionStore = {
  activeConnectionId: endpointConnection.id,
  connectedIds: new Set<string>(),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [endpointConnection],
  getConfig: () => connection,
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

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mountedApps: App[] = [];

afterEach(() => {
  while (mountedApps.length > 0) {
    mountedApps.pop()?.unmount();
  }
  document.body.innerHTML = "";
  connection = endpointConnection;
  editorSettings.sidebarShowConnectionEndpoints = false;
  editorSettings.sidebarShowConnectionNotes = false;
  editorSettings.sidebarObjectInfoMode = "comment-inline";
  editorSettings.sidebarAllowHorizontalScroll = false;
});

function createTreeRuntimeHost(): SidebarTreeRuntimeHost {
  return {
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    handleToggleExpand: vi.fn(),
    isSelected: () => false,
    isMultiSelected: () => false,
    isAnchor: () => false,
    usesSelectionSetHighlight: () => false,
    isSelectionLead: () => false,
    isDragging: () => false,
    dragVisualState: () => ({
      dragging: false,
      showBefore: false,
      showAfter: false,
      showInside: false,
      dropTargetNodeId: null,
    }),
    tableVGroupDropTargetNodeId: () => null,
    updateTreeDragTarget: vi.fn(),
    clearTreeDragTarget: vi.fn(),
    canDragPinnedOrder: () => false,
    startPinnedOrderDrag: vi.fn(),
    isNodeHighlighted: () => false,
    onRowContextMenu: vi.fn(),
    executeDefaultNodeAction: vi.fn(),
  };
}

function mountTreeItem(node: TreeNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const runtime = createSidebarTreeRuntime(createTreeRuntimeHost());
  const rootComponent = defineComponent({
    setup() {
      return () => h(TreeItem, { node, depth: 1 });
    },
  });

  const app = createApp(rootComponent);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  mountedApps.push(app);

  return container;
}

function rowText(container: HTMLElement, nodeId: string): string {
  const row = container.querySelector(`[data-node-id="${nodeId}"]`);
  expect(row).not.toBeNull();
  return row?.textContent ?? "";
}

function connectionNode(): TreeNode {
  return { id: "connection-1", label: "Orders", type: "connection", connectionId: endpointConnection.id };
}

describe("TreeItem connection endpoint display", () => {
  it("hides the endpoint text when the setting is off", async () => {
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(rowText(container, "connection-1")).not.toContain("192.168.1.10:5432@postgres");
  });

  it("appends host:port@user after the connection name when enabled", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(rowText(container, "connection-1")).toContain("192.168.1.10:5432@postgres");
  });

  it("shows only the endpoint when the username is blank", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    connection = { ...endpointConnection, username: "" };
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(rowText(container, "connection-1")).toContain("192.168.1.10:5432");
    expect(rowText(container, "connection-1")).not.toContain("@");
  });

  it("renders nothing when no endpoint can be derived", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    connection = { ...endpointConnection, host: "", port: 0, database: "" };
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(rowText(container, "connection-1").trim()).toBe("Orders");
  });

  it("shows the endpoint beside a visible connection note", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    editorSettings.sidebarShowConnectionNotes = true;
    const container = mountTreeItem({ ...connectionNode(), comment: "primary replica" });
    await nextTick();
    const text = rowText(container, "connection-1");
    expect(text).toContain("192.168.1.10:5432@postgres");
    expect(text).toContain("primary replica");
  });

  it("keeps the endpoint visible when comments are hidden", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    editorSettings.sidebarObjectInfoMode = "hidden";
    const container = mountTreeItem({ ...connectionNode(), comment: "primary replica" });
    await nextTick();
    const text = rowText(container, "connection-1");
    expect(text).toContain("192.168.1.10:5432@postgres");
    expect(text).not.toContain("primary replica");
  });

  it("does not render the endpoint on non-connection rows", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    const container = mountTreeItem({ id: "table-1", label: "orders", type: "table", connectionId: endpointConnection.id, database: "shop" });
    await nextTick();
    expect(rowText(container, "table-1")).not.toContain("192.168.1.10:5432");
  });

  it("widens the row instead of truncating when horizontal scroll is enabled", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    editorSettings.sidebarAllowHorizontalScroll = true;
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(container.querySelector('[data-node-id="connection-1"]')?.className).toContain("w-max");
  });

  it("keeps the row constrained when horizontal scroll is off", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    const container = mountTreeItem(connectionNode());
    await nextTick();
    expect(container.querySelector('[data-node-id="connection-1"]')?.className).not.toContain("w-max");
  });

  it("grows the endpoint from a zero basis in constrained rows so the name keeps its width", async () => {
    editorSettings.sidebarShowConnectionEndpoints = true;
    const container = mountTreeItem(connectionNode());
    await nextTick();
    const endpoint = container.querySelector(".sidebar-connection-endpoint");
    expect(endpoint?.className).toContain("flex-1");
    expect(endpoint?.className).toContain("min-w-0");
    expect(endpoint?.className).not.toContain("whitespace-nowrap");
  });
});
