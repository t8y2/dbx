// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { SidebarConnectionIconStyle, SidebarDensity } from "@/stores/settingsStore";

const mockSettings = reactive({
  editorSettings: {
    shortcuts: { openDataInNewTab: "" },
    sidebarActivation: "double",
    sidebarAllowHorizontalScroll: false,
    sidebarHiddenTablePrefixes: [],
    sidebarObjectInfoMode: "none",
    sidebarDensity: "default" as SidebarDensity,
    sidebarConnectionIconStyle: "classic" as SidebarConnectionIconStyle,
    sidebarShowTooltips: false,
    sidebarIndent: 16,
    sidebarTableSearchLocal: true,
  },
});

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: reactive(new Set(["connection-1"])),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: vi.fn<(id: string) => ConnectionConfig | undefined>(() => undefined),
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
  sidebarLayout: { groups: [], order: [] },
  tableNameFilterForScope: () => undefined,
  treeNodes: [],
  treeSelectionAnchorId: null as string | null,
  refreshSidebarTableSearch: vi.fn(),
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => mockSettings,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/plugins/pluginIconResolver", () => ({
  resolvePluginIcon: async () => "https://example.invalid/plugin-icon.svg",
}));

const mountedApps: App[] = [];

afterEach(() => {
  while (mountedApps.length > 0) {
    mountedApps.pop()?.unmount();
  }
  document.body.innerHTML = "";
  mockSettings.editorSettings.sidebarDensity = "default";
  mockSettings.editorSettings.sidebarConnectionIconStyle = "classic";
  connectionStore.connectedIds.add("connection-1");
  connectionStore.getConfig.mockReset();
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
      return () => h(TreeItem, { node, depth: 0 });
    },
  });

  const app = createApp(rootComponent);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  mountedApps.push(app);

  return container;
}

describe("TreeItem connection icon style", () => {
  const node: TreeNode = { id: "connection-1", type: "connection", label: "Example", connectionId: "connection-1" };

  it("switches an existing connection row between its original icon and the state badge", async () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "mysql" } as ConnectionConfig);
    const container = mountTreeItem(node);
    expect(container.querySelector('img[src$="/icons/database/mysql.svg"]')).not.toBeNull();

    mockSettings.editorSettings.sidebarConnectionIconStyle = "badge";
    await nextTick();
    const badge = container.querySelector<HTMLElement>('[data-connection-badge="mysql"]');
    expect(badge?.dataset.connected).toBe("true");
    expect(badge?.parentElement?.style.width).toBe("16px");

    connectionStore.connectedIds.delete(node.id);
    mockSettings.editorSettings.sidebarDensity = "compact";
    await nextTick();
    expect(badge?.dataset.connected).toBe("false");
    expect(badge?.style.backgroundColor).toBe("#737373");
    expect(badge?.parentElement?.style.width).toBe("16px");

    mockSettings.editorSettings.sidebarConnectionIconStyle = "classic";
    await nextTick();
    expect(container.querySelector('img[src$="/icons/database/mysql.svg"]')?.classList.contains("opacity-70")).toBe(true);
    expect(container.querySelector("[data-connection-badge]")).toBeNull();
  });

  it("renders a generic mark in a full-size badge for a future database without artwork", () => {
    connectionStore.getConfig.mockReturnValue({ db_type: "future-database" } as ConnectionConfig);
    mockSettings.editorSettings.sidebarConnectionIconStyle = "badge";
    const container = mountTreeItem(node);
    const badge = container.querySelector('[data-connection-badge="generic"]');
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(badge?.parentElement?.style.width).toBe("16px");
  });

  it("keeps connection group folders the same size as colored badges when density changes", async () => {
    mockSettings.editorSettings.sidebarConnectionIconStyle = "badge";
    const container = mountTreeItem({ id: "group", type: "connection-group", label: "Example group", isExpanded: true });
    const folder = container.querySelector("svg.lucide-folder-open");
    expect(folder?.parentElement?.style.width).toBe("16px");

    mockSettings.editorSettings.sidebarDensity = "compact";
    await nextTick();
    expect(folder?.parentElement?.style.width).toBe("16px");
    expect(container.querySelector("[data-connection-badge]")).toBeNull();
  });

  it.each(["classic", "badge"] as const)("uses the plugin's own icon in %s mode", async (style) => {
    connectionStore.getConfig.mockReturnValue({ db_type: "plugin", plugin_id: "example", plugin_connection_provider: "example-provider" } as ConnectionConfig);
    mockSettings.editorSettings.sidebarConnectionIconStyle = style;
    const container = mountTreeItem(node);
    await vi.waitFor(() => expect(container.querySelector('img[src="https://example.invalid/plugin-icon.svg"]')).not.toBeNull());
    expect(container.querySelector("[data-connection-badge]")).toBeNull();
  });
});

describe("TreeItem sidebarDensity layout", () => {
  it("renders default min-h-7 and py-1 when sidebarDensity is default", async () => {
    mockSettings.editorSettings.sidebarDensity = "default";
    const node: TreeNode = {
      id: "table-1",
      label: "users",
      type: "table",
      connectionId: "connection-1",
    };

    const container = mountTreeItem(node);
    await nextTick();

    const row = container.querySelector('[data-node-id="table-1"]');
    expect(row).not.toBeNull();
    expect(row?.classList.contains("min-h-7")).toBe(true);
    expect(row?.classList.contains("py-1")).toBe(true);
    expect(row?.classList.contains("min-h-6")).toBe(false);
    expect(row?.classList.contains("py-0.5")).toBe(false);
  });

  it("renders compact min-h-6 and py-0.5 when sidebarDensity is compact", async () => {
    mockSettings.editorSettings.sidebarDensity = "compact";
    const node: TreeNode = {
      id: "table-1",
      label: "users",
      type: "table",
      connectionId: "connection-1",
    };

    const container = mountTreeItem(node);
    await nextTick();

    const row = container.querySelector('[data-node-id="table-1"]');
    expect(row).not.toBeNull();
    expect(row?.classList.contains("min-h-6")).toBe(true);
    expect(row?.classList.contains("py-0.5")).toBe(true);
    expect(row?.classList.contains("min-h-7")).toBe(false);
    expect(row?.classList.contains("py-1")).toBe(false);
  });

  it("adjusts search control row and input height in compact mode", async () => {
    mockSettings.editorSettings.sidebarDensity = "compact";
    const searchNode: TreeNode = {
      id: "search-1",
      label: "sidebar.searchTablesInCurrentScope",
      type: "table-search-control",
      tableSearchParentId: "db-1",
    };

    const container = mountTreeItem(searchNode);
    await nextTick();

    const control = container.querySelector("[data-sidebar-table-search-control]");
    expect(control).not.toBeNull();
    expect(control?.classList.contains("h-6")).toBe(true);
    expect(control?.classList.contains("h-7")).toBe(false);

    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.classList.contains("h-5")).toBe(true);
    expect(input?.classList.contains("h-6")).toBe(false);
  });
});
