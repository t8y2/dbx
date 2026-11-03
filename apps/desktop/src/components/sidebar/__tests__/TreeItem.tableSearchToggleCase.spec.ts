// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { TreeNode } from "@/types/database";

const mockSettings = reactive({
  editorSettings: {
    shortcuts: {
      toggleCaseSelection: "Mod+Shift+U",
      uppercaseSelection: "Shift+Alt+U",
      lowercaseSelection: "Shift+Alt+L",
    },
    sidebarActivation: "double",
    sidebarAllowHorizontalScroll: false,
    sidebarHiddenTablePrefixes: [],
    sidebarObjectInfoMode: "none",
    sidebarDensity: "default",
    sidebarShowTooltips: false,
    sidebarIndent: 16,
    sidebarTableSearchLocal: true,
  },
});

const connectionStore = reactive({
  activeConnectionId: "connection-1",
  connectedIds: new Set(["connection-1"]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [],
  getConfig: () => undefined,
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
  sidebarTableSearchQueries: {} as Record<string, string>,
  setSidebarTableSearchQuery: vi.fn((nodeId: string, q: string) => {
    connectionStore.sidebarTableSearchQueries[nodeId] = q;
  }),
  tableNameFilterForScope: () => undefined,
  treeNodes: [],
  treeSelectionAnchorId: null as string | null,
  refreshSidebarTableSearch: vi.fn(),
});

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

const mountedApps: App[] = [];

afterEach(() => {
  while (mountedApps.length > 0) {
    mountedApps.pop()?.unmount();
  }
  document.body.innerHTML = "";
  connectionStore.sidebarTableSearchQueries = {};
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

function mountTableSearchTreeItem(parentId = "db-1"): { container: HTMLElement; input: HTMLInputElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const searchNode: TreeNode = {
    id: `search-${parentId}`,
    label: "sidebar.searchTablesInCurrentScope",
    type: "table-search-control",
    tableSearchParentId: parentId,
  };

  const runtime = createSidebarTreeRuntime(createTreeRuntimeHost());
  const rootComponent = defineComponent({
    setup() {
      return () => h(TreeItem, { node: searchNode, depth: 1 });
    },
  });

  const app = createApp(rootComponent);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  mountedApps.push(app);

  const input = container.querySelector<HTMLInputElement>("input")!;
  return { container, input };
}

function pressToggleCase(target: HTMLElement, overrides: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "u",
    code: "KeyU",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  target.dispatchEvent(event);
  return event;
}

describe("TreeItem table search case toggling behavior", () => {
  it("toggles case of selected text inside the table search input", async () => {
    const { input } = mountTableSearchTreeItem("db-test");
    await nextTick();

    input.value = "user_accounts";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    // Select "user" (range 0 to 4)
    input.setSelectionRange(0, 4);

    const event1 = pressToggleCase(input);
    expect(event1.defaultPrevented).toBe(true);
    expect(input.value).toBe("USER_accounts");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);

    // Press again to toggle back to lowercase
    const event2 = pressToggleCase(input);
    expect(event2.defaultPrevented).toBe(true);
    expect(input.value).toBe("user_accounts");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
  });

  it("toggles full input case when cursor is resting without selection", async () => {
    const { input } = mountTableSearchTreeItem("db-test");
    await nextTick();

    input.value = "order_items";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    // Cursor at end
    input.setSelectionRange(11, 11);

    pressToggleCase(input);
    expect(input.value).toBe("ORDER_ITEMS");
    expect(input.selectionStart).toBe(11);
    expect(input.selectionEnd).toBe(11);

    pressToggleCase(input);
    expect(input.value).toBe("order_items");
    expect(input.selectionStart).toBe(11);
    expect(input.selectionEnd).toBe(11);
  });

  it("handles event dispatched on control wrapper via fallback handler", async () => {
    const { container, input } = mountTableSearchTreeItem("db-test");
    await nextTick();

    input.value = "customers";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    input.setSelectionRange(0, 9);
    const control = container.querySelector<HTMLElement>("[data-sidebar-table-search-control]")!;

    const event = pressToggleCase(control);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("CUSTOMERS");
  });
});
