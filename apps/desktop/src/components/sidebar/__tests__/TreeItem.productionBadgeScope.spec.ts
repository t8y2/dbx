// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const productionConnection: ConnectionConfig = {
  id: "connection-1",
  name: "Orders",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "",
  is_production: true,
};

const databaseMarkedConnection: ConnectionConfig = {
  ...productionConnection,
  is_production: false,
  production_databases: ["analytics"],
};

let connection = productionConnection;

const connectionStore = {
  activeConnectionId: productionConnection.id,
  connectedIds: new Set([productionConnection.id]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [productionConnection],
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
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { openDataInNewTab: "" },
      sidebarActivation: "double",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
      sidebarDensity: "default",
      sidebarShowTooltips: false,
      sidebarIndent: 16,
      sidebarTableSearchLocal: true,
    },
  }),
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
  connection = productionConnection;
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

function mountTreeItem(node: TreeNode, isStickyContext = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const runtime = createSidebarTreeRuntime(createTreeRuntimeHost());
  const rootComponent = defineComponent({
    setup() {
      return () => h(TreeItem, { node, depth: 1, isStickyContext });
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

describe("TreeItem production badge scope", () => {
  it("keeps the connection's production marker visible", async () => {
    const container = mountTreeItem({ id: "connection-1", label: "Orders", type: "connection", connectionId: productionConnection.id });
    await nextTick();
    expect(rowText(container, "connection-1")).toContain("PROD");
  });

  it.each(["database", "schema"] as const)("reserves space for the independent badge on a fixed %s", async (type) => {
    connection = { ...productionConnection, production_badge_scope: "connection" };
    const container = mountTreeItem({ id: "scope-1", label: "analytics", type, connectionId: productionConnection.id, database: "analytics", schema: "public" }, true);
    await nextTick();
    expect(rowText(container, "scope-1")).not.toContain("PROD");
    expect(container.querySelector<HTMLElement>('[data-node-id="scope-1"]')?.style.paddingRight).toBe("72px");
  });

  it.each(["database", "schema"] as const)("marks ordinary %s rows by default", async (type) => {
    const container = mountTreeItem({ id: "scope-1", label: "analytics", type, connectionId: productionConnection.id, database: "analytics", schema: "public" });
    await nextTick();
    expect(rowText(container, "scope-1")).toContain("PROD");
  });
  it.each(["database", "schema"] as const)("does not mark ordinary %s rows in connection scope", async (type) => {
    connection = { ...productionConnection, production_badge_scope: "connection" };
    const container = mountTreeItem({ id: "scope-connection", label: "analytics", type, connectionId: productionConnection.id, database: "analytics", schema: "public" });
    await nextTick();
    expect(rowText(container, "scope-connection")).not.toContain("PROD");
  });

  it("keeps the fixed database/schema row badge inline outside connection scope", async () => {
    connection = { ...productionConnection, production_badge_scope: "database" };
    const container = mountTreeItem({ id: "scope-inline", label: "analytics", type: "schema", connectionId: productionConnection.id, database: "analytics", schema: "public" }, true);
    await nextTick();
    expect(rowText(container, "scope-inline")).toContain("PROD");
    expect(container.querySelector<HTMLElement>('[data-node-id="scope-inline"]')?.style.paddingRight).toBe("");
  });

  it("marks object rows with one aligned marker in table scope", async () => {
    connection = { ...productionConnection, production_badge_scope: "table" };

    const container = mountTreeItem({ id: "table-1", label: "orders", type: "table", connectionId: productionConnection.id, database: "analytics" });
    await nextTick();

    expect(container.querySelector('[data-node-id="table-1"] [data-production-marker]')).not.toBeNull();
    expect(rowText(container, "table-1")).not.toContain("PROD");
  });

  it("keeps the text badge on container rows in table scope", async () => {
    connection = { ...productionConnection, production_badge_scope: "table" };

    const container = mountTreeItem({ id: "schema-1", label: "analytics", type: "schema", connectionId: productionConnection.id, database: "analytics" });
    await nextTick();

    expect(container.querySelector('[data-node-id="schema-1"] [data-production-marker]')).toBeNull();
    expect(rowText(container, "schema-1")).toContain("PROD");
  });

  it("leaves ordinary object rows unmarked inside a production connection", async () => {
    const container = mountTreeItem({ id: "table-1", label: "orders", type: "table", connectionId: productionConnection.id, database: "shop" });
    await nextTick();

    expect(rowText(container, "table-1")).not.toContain("PROD");
  });

  it("keeps grouping and detail rows unmarked", async () => {
    const groupContainer = mountTreeItem({ id: "group-tables-1", label: "tree.tables", type: "group-tables", connectionId: productionConnection.id, database: "shop" });
    const columnContainer = mountTreeItem({
      id: "column-1",
      label: "status",
      type: "column",
      connectionId: productionConnection.id,
      database: "shop",
      meta: { is_nullable: true, is_primary_key: false },
    });
    await nextTick();

    expect(rowText(groupContainer, "group-tables-1")).not.toContain("PROD");
    expect(rowText(columnContainer, "column-1")).not.toContain("PROD");
  });

  it("leaves object rows unmarked when the connection is not production", async () => {
    connection = { ...productionConnection, is_production: false };

    const container = mountTreeItem({ id: "table-1", label: "orders", type: "table", connectionId: productionConnection.id, database: "shop" });
    await nextTick();

    expect(rowText(container, "table-1")).not.toContain("PROD");
  });

  it("leaves ordinary objects unmarked even in a database marked as production", async () => {
    connection = databaseMarkedConnection;

    const markedContainer = mountTreeItem({ id: "table-1", label: "orders", type: "table", connectionId: productionConnection.id, database: "analytics" });
    const otherContainer = mountTreeItem({ id: "table-2", label: "orders", type: "table", connectionId: productionConnection.id, database: "staging" });
    await nextTick();

    expect(rowText(markedContainer, "table-1")).not.toContain("PROD");
    expect(rowText(otherContainer, "table-2")).not.toContain("PROD");
  });
});
