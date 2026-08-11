import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
import type { TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import { useSidebarConnectionMutationRuntime } from "@/composables/useSidebarConnectionMutationRuntime";

function connectionNode(connectionId: string): TreeNode {
  return {
    id: connectionId,
    label: connectionId,
    type: "connection",
    connectionId,
    isExpanded: false,
    children: [],
  };
}

function connectionStore(selectedTreeNodeIds: string[]) {
  const lastSelectedTreeNodeId = selectedTreeNodeIds[selectedTreeNodeIds.length - 1] ?? null;
  return {
    selectedTreeNodeIds: [...selectedTreeNodeIds],
    selectedTreeNodeId: lastSelectedTreeNodeId,
    treeSelectionAnchorId: lastSelectedTreeNodeId,
    connectionMultiSelectActive: selectedTreeNodeIds.length > 0,
    moveConnectionToGroup: vi.fn(),
    createConnectionGroup: vi.fn(() => "group-new"),
    connectedIds: new Set<string>(),
    connectingIds: new Set<string>(),
    isTreeNodeChildrenLoaded: vi.fn(() => false),
    getConfig: vi.fn(() => undefined),
  };
}

function runtime(activeNode: TreeNode, store: ReturnType<typeof connectionStore>) {
  return useSidebarConnectionMutationRuntime({
    activeNode: shallowRef(activeNode),
    releaseActiveNodeReference: vi.fn(),
    selectedTreeNodesInVisibleOrder: () => [],
    connectionStore: store as any,
    queryStore: { openDatabaseKeys: new Set<string>() } as any,
    requestGroupRename: vi.fn(),
    groupCreated: vi.fn(),
    openVisibleDatabases: vi.fn(),
    openVisibleSchemas: vi.fn(),
  });
}

describe("sidebar connection move selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarFormTarget.value = null;
  });

  it("removes only the right-clicked connection after moving to an existing group", () => {
    const store = connectionStore(["conn-hidden", "conn-active"]);
    const { moveToGroup } = runtime(connectionNode("conn-active"), store);

    moveToGroup("group-a");

    expect(store.moveConnectionToGroup).toHaveBeenCalledWith("conn-active", "group-a");
    expect(store.selectedTreeNodeIds).toEqual(["conn-hidden"]);
    expect(store.selectedTreeNodeId).toBe("conn-hidden");
    expect(store.treeSelectionAnchorId).toBe("conn-hidden");
    expect(store.connectionMultiSelectActive).toBe(true);
  });

  it("releases the final selected connection after moving it to ungrouped", () => {
    const store = connectionStore(["conn-active"]);
    const { moveToGroup } = runtime(connectionNode("conn-active"), store);

    moveToGroup(null);

    expect(store.moveConnectionToGroup).toHaveBeenCalledWith("conn-active", null);
    expect(store.selectedTreeNodeIds).toEqual([]);
    expect(store.selectedTreeNodeId).toBeNull();
    expect(store.treeSelectionAnchorId).toBeNull();
    expect(store.connectionMultiSelectActive).toBe(false);
  });

  it("uses the dialog target when creating a group and preserves filtered selections", () => {
    const store = connectionStore(["conn-dialog", "conn-hidden"]);
    sidebarFormTarget.value = connectionNode("conn-dialog");
    const { createGroupAndMoveConnection } = runtime(connectionNode("conn-current"), store);

    expect(createGroupAndMoveConnection("  New group  ")).toBe(true);

    expect(store.createConnectionGroup).toHaveBeenCalledWith("New group");
    expect(store.moveConnectionToGroup).toHaveBeenCalledWith("conn-dialog", "group-new");
    expect(store.selectedTreeNodeIds).toEqual(["conn-hidden"]);
    expect(store.connectionMultiSelectActive).toBe(true);
  });

  it("keeps the selection when a new-group move is cancelled", () => {
    const store = connectionStore(["conn-active", "conn-hidden"]);
    const { createGroupAndMoveConnection } = runtime(connectionNode("conn-active"), store);

    expect(createGroupAndMoveConnection("   ")).toBe(false);

    expect(store.createConnectionGroup).not.toHaveBeenCalled();
    expect(store.moveConnectionToGroup).not.toHaveBeenCalled();
    expect(store.selectedTreeNodeIds).toEqual(["conn-active", "conn-hidden"]);
    expect(store.connectionMultiSelectActive).toBe(true);
  });

  it("does not release the connection when the move fails", () => {
    const store = connectionStore(["conn-active", "conn-hidden"]);
    store.moveConnectionToGroup.mockImplementation(() => {
      throw new Error("move failed");
    });
    const { moveToGroup } = runtime(connectionNode("conn-active"), store);

    expect(() => moveToGroup("group-a")).toThrow("move failed");
    expect(store.selectedTreeNodeIds).toEqual(["conn-active", "conn-hidden"]);
    expect(store.connectionMultiSelectActive).toBe(true);
  });
});
