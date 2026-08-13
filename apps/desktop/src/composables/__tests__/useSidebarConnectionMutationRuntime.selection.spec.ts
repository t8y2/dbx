import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
import type { TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
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
    disconnect: vi.fn().mockResolvedValue(undefined),
    isTreeNodeChildrenLoaded: vi.fn(() => false),
    getConfig: vi.fn(() => undefined),
  };
}

function runtime(activeNode: TreeNode, store: ReturnType<typeof connectionStore>, selectedNodes: TreeNode[] = []) {
  return useSidebarConnectionMutationRuntime({
    activeNode: shallowRef(activeNode),
    releaseActiveNodeReference: vi.fn(),
    selectedTreeNodesInVisibleOrder: () => selectedNodes,
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

describe("sidebar connection disconnect selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarFormTarget.value = null;
  });

  it("disconnects every connected connection in the right-clicked selection", async () => {
    const nodes = [connectionNode("conn-1"), connectionNode("conn-2"), connectionNode("conn-3")];
    const store = connectionStore(nodes.map((node) => node.id));
    store.connectedIds = new Set(["conn-1", "conn-3"]);
    const { disconnectConnection, connectionDisconnectMenuLabel } = runtime(nodes[1], store, nodes);

    expect(connectionDisconnectMenuLabel()).toBe('contextMenu.closeSelectedConnections:{"count":2}');
    await disconnectConnection();

    expect(store.disconnect.mock.calls).toEqual([["conn-1"], ["conn-3"]]);
    expect(mocks.toast).toHaveBeenCalledWith('connection.disconnectedSelected:{"count":2}', 2000);
  });

  it("recomputes disconnect availability when the selected connections change", () => {
    const nodes = [connectionNode("conn-1"), connectionNode("conn-2")];
    const selected = [nodes[0]];
    const store = connectionStore(selected.map((node) => node.id));
    store.connectedIds = new Set(["conn-2"]);
    const { canDisconnectConnection, connectionDisconnectMenuLabel } = runtime(nodes[0], store, selected);

    expect(canDisconnectConnection()).toBe(false);

    selected.push(nodes[1]);

    expect(canDisconnectConnection()).toBe(true);
    expect(connectionDisconnectMenuLabel()).toBe('contextMenu.closeSelectedConnections:{"count":1}');
  });

  it("continues disconnecting after one selected connection fails", async () => {
    const nodes = [connectionNode("conn-1"), connectionNode("conn-2")];
    const store = connectionStore(nodes.map((node) => node.id));
    store.connectedIds = new Set(nodes.map((node) => node.connectionId!));
    store.disconnect.mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(undefined);
    const { disconnectConnection } = runtime(nodes[0], store, nodes);

    await disconnectConnection();

    expect(store.disconnect).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith('connection.disconnectSelectedPartial:{"succeeded":1,"failed":1}', 5000);
  });

  it("disconnects only the right-clicked connection outside the current selection", async () => {
    const selected = [connectionNode("conn-1"), connectionNode("conn-2")];
    const current = connectionNode("conn-3");
    const store = connectionStore(selected.map((node) => node.id));
    store.connectedIds = new Set(["conn-1", "conn-2", "conn-3"]);
    const { disconnectConnection } = runtime(current, store, selected);

    await disconnectConnection();

    expect(store.disconnect).toHaveBeenCalledWith("conn-3");
    expect(store.disconnect).toHaveBeenCalledTimes(1);
  });
});
