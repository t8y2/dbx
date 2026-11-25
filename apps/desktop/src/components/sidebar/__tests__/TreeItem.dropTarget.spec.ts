// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import type { SidebarOrderEntry, TreeNode } from "@/types/database";

const connectionStore = {
  activeConnectionId: "connection-1",
  connectedIds: new Set<string>(),
  connectingIds: new Set<string>(),
  connectionMultiSelectActive: false,
  connectionErrors: {} as Record<string, string>,
  connections: [],
  getConfig: () => ({ id: "connection-1", db_type: "sqlite" }),
  getSidebarVisibleFilterSummary: () => null,
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarLayout: { groups: [] as { id: string; name: string; collapsed: boolean }[], order: [] as SidebarOrderEntry[] },
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [] as TreeNode[],
  treeSelectionAnchorId: null as string | null,
  // The sidebar reorder entry point is the only side effect this spec asserts on.
  reorderSidebarEntries: vi.fn(),
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
      sidebarActivation: "single",
      sidebarAllowHorizontalScroll: false,
      sidebarHiddenTablePrefixes: [],
      sidebarObjectInfoMode: "none",
      sidebarCopyTableNameSeparator: "comma",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const sourceNode: TreeNode = { id: "connection-source", label: "Source", type: "connection", connectionId: "connection-source" };
const targetConnection: TreeNode = { id: "connection-target", label: "Target", type: "connection", connectionId: "connection-target" };
const targetGroup: TreeNode = { id: "group-target", label: "Group", type: "connection-group" };

const mountedApps: App[] = [];

async function mountTreeItem(node: TreeNode, props: { moveToGroupOnly?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 0, ...props }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, createSidebarTreeRuntime());
  app.mount(container);
  await nextTick();

  const row = container.querySelector<HTMLElement>("[tabindex]");
  if (!row) throw new Error(`Tree item row was not rendered: ${container.innerHTML}`);
  return row;
}

/**
 * Mounts a draggable connection row plus the drop target, starts a drag from the
 * source and hovers the target at `clientY`. Returns both rows.
 */
async function hoverTarget(target: TreeNode, clientY: number, props: { moveToGroupOnly?: boolean; source?: TreeNode } = {}) {
  const { source, ...treeItemProps } = props;
  const sourceRow = await mountTreeItem(source ?? sourceNode, treeItemProps);
  const targetRow = await mountTreeItem(target, treeItemProps);
  vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({ top: 100, height: 30 } as DOMRect);

  sourceRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY: 20 }));
  targetRow.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 20, clientY }));
  await nextTick();

  return { sourceRow, targetRow };
}

function dropAt(targetRow: HTMLElement) {
  targetRow.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 20, clientY: 120 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 20, clientY: 120 }));
}

afterEach(() => {
  // Never leak an active drag into the next test: the drag state is a module singleton.
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  connectionStore.reorderSidebarEntries.mockReset();
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.selectedTreeNodeIdsSet = new Set();
  connectionStore.selectedTreeNodeId = null;
  connectionStore.sidebarLayout = { groups: [], order: [] };
});

describe("TreeItem drag drop target gating", () => {
  it("rejects before/after drop targets while the connection list is display-sorted", async () => {
    const { targetRow } = await hoverTarget(targetConnection, 120, { moveToGroupOnly: true });

    // The manual order behind before/after is invisible in a sorted list, so no
    // insertion indicator may be shown and the target must be dropped entirely.
    expect(targetRow.querySelector(".tree-item-drop-indicator")).toBeNull();
    expect(targetRow.className).not.toContain("ring-1");

    dropAt(targetRow);
    expect(connectionStore.reorderSidebarEntries).not.toHaveBeenCalled();
  });

  it("rejects before/after even when the dragged row sits in another group", async () => {
    // Leaving a group must go through "drop into the target group"; a bare
    // before/after at root level would still only rewrite the invisible manual
    // order, so it stays rejected rather than being allowed for cross-group
    // parents.
    connectionStore.sidebarLayout = {
      groups: [{ id: "group-source", name: "Source group", collapsed: false }],
      order: [{ type: "group", id: "group-source", children: [{ type: "connection", id: sourceNode.id }] }],
    };
    const { targetRow } = await hoverTarget(targetConnection, 120, { moveToGroupOnly: true });

    expect(targetRow.querySelector(".tree-item-drop-indicator")).toBeNull();

    dropAt(targetRow);
    expect(connectionStore.reorderSidebarEntries).not.toHaveBeenCalled();
  });

  it("keeps the inside drop target while display-sorted, because it is order-independent", async () => {
    // A group row is the only row that can resolve an "inside" drop, so the
    // sorted-view gate must keep it while rejecting that row's before/after.
    connectionStore.sidebarLayout = {
      groups: [{ id: "group-target", name: "Group", collapsed: false }],
      order: [{ type: "group", id: "group-target", children: [] }],
    };
    const { targetRow } = await hoverTarget(targetGroup, 115, { moveToGroupOnly: true });

    expect(targetRow.querySelector(".tree-item-drop-indicator")).toBeNull();
    expect(targetRow.className).toContain("ring-1");

    dropAt(targetRow);
    expect(connectionStore.reorderSidebarEntries).toHaveBeenCalledWith(["connection-source"], "group-target", "inside", { preserveSameGroupOrder: true });
  });

  it("accepts before/after drop targets when the manual order is visible", async () => {
    const { targetRow } = await hoverTarget(targetConnection, 120, { moveToGroupOnly: false });

    expect(targetRow.querySelector(".tree-item-drop-indicator")).not.toBeNull();
    expect(targetRow.className).not.toContain("ring-1");

    dropAt(targetRow);
    expect(connectionStore.reorderSidebarEntries).toHaveBeenCalledWith(["connection-source"], "connection-target", "after", { preserveSameGroupOrder: false });
  });
});
