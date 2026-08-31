import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { connectionGroupDeleteTargetSnapshot, deleteConnectionsWithGroup, showDeleteGroupConfirm, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
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

function connectionGroupNode(groupId: string): TreeNode {
  return {
    id: groupId,
    label: groupId,
    type: "connection-group",
    isExpanded: true,
    children: [],
  };
}

function vectorDatabaseNode(database: string): TreeNode {
  return {
    id: `conn-1:${database}`,
    label: database,
    type: "vector-database",
    connectionId: "conn-1",
    database,
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
    connectionIdsInGroups: vi.fn((): string[] => []),
    deleteConnectionGroups: vi.fn().mockResolvedValue([]),
    removeConnections: vi.fn().mockResolvedValue(undefined),
    connectedIds: new Set<string>(),
    connectingIds: new Set<string>(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    disconnectAndForgetConnectionPassword: vi.fn().mockResolvedValue(undefined),
    isTreeNodeChildrenLoaded: vi.fn(() => false),
    getConfig: vi.fn(() => undefined),
    isDefaultDatabase: vi.fn(() => false),
  };
}

function runtime(activeNode: TreeNode, store: ReturnType<typeof connectionStore>, selectedNodes: TreeNode[] = [], requestGroupRename = vi.fn()) {
  return useSidebarConnectionMutationRuntime({
    activeNode: shallowRef(activeNode),
    releaseActiveNodeReference: vi.fn(),
    selectedTreeNodesInVisibleOrder: () => selectedNodes,
    connectionStore: store as any,
    queryStore: { openDatabaseKeys: new Set<string>() } as any,
    requestGroupRename,
    openVisibleDatabases: vi.fn(),
    openVisibleSchemas: vi.fn(),
  });
}

describe("sidebar default database state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarFormTarget.value = null;
  });

  it("recognizes the configured Milvus vector database as default", () => {
    const store = connectionStore([]);
    store.isDefaultDatabase.mockReturnValue(true);
    const { isNodeDefaultDatabase } = runtime(vectorDatabaseNode("analytics"), store);

    expect(isNodeDefaultDatabase.value).toBe(true);
    expect(store.isDefaultDatabase).toHaveBeenCalledWith("conn-1", "analytics");
  });
});

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

describe("sidebar connection group deletion selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarFormTarget.value = null;
    connectionGroupDeleteTargetSnapshot.value = [];
    deleteConnectionsWithGroup.value = false;
    showDeleteGroupConfirm.value = false;
  });

  it("snapshots every selected group for the confirmation dialog", () => {
    const groups = [connectionGroupNode("group-1"), connectionGroupNode("group-2")];
    const store = connectionStore(groups.map((group) => group.id));
    const { connectionGroupDeleteConfirmMessage, connectionGroupDeleteMenuLabel, deleteConnectionGroup } = runtime(groups[1], store, groups);

    expect(connectionGroupDeleteMenuLabel()).toBe('connectionGroup.deleteSelectedGroups:{"count":2}');
    deleteConnectionGroup();
    groups.splice(0);

    expect(showDeleteGroupConfirm.value).toBe(true);
    expect(connectionGroupDeleteTargetSnapshot.value.map((group) => group.id)).toEqual(["group-1", "group-2"]);
    expect(connectionGroupDeleteConfirmMessage()).toBe('connectionGroup.deleteSelectedGroupsConfirmMessage:{"count":2}');
  });

  it("starts inline rename after creating a subgroup", () => {
    const parent = connectionGroupNode("group-parent");
    const store = connectionStore([parent.id]);
    const requestGroupRename = vi.fn();
    const { newSubgroup } = runtime(parent, store, [parent], requestGroupRename);

    newSubgroup();

    expect(store.createConnectionGroup).toHaveBeenCalledWith("connectionGroup.newGroupDefault", "group-parent");
    expect(requestGroupRename).toHaveBeenCalledWith("group-new");
  });

  it("deletes nested connections and groups as one confirmed operation", async () => {
    const groups = [connectionGroupNode("group-1"), connectionGroupNode("group-2")];
    const store = connectionStore(groups.map((group) => group.id));
    store.deleteConnectionGroups.mockResolvedValue(["conn-1", "conn-2"]);
    const { confirmDeleteGroup, deleteConnectionGroup } = runtime(groups[0], store, groups);

    deleteConnectionGroup();
    deleteConnectionsWithGroup.value = true;
    await confirmDeleteGroup();

    expect(store.removeConnections).not.toHaveBeenCalled();
    expect(store.deleteConnectionGroups).toHaveBeenCalledWith(["group-1", "group-2"], true);
    expect(store.disconnect.mock.calls).toEqual([["conn-1"], ["conn-2"]]);
    expect(showDeleteGroupConfirm.value).toBe(false);
    expect(connectionGroupDeleteTargetSnapshot.value).toEqual([]);
    expect(deleteConnectionsWithGroup.value).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith('connection.groupsDeleted:{"count":2}', 2000);
  });

  it("keeps the groups and dialog open when connection persistence fails", async () => {
    const group = connectionGroupNode("group-1");
    const store = connectionStore([group.id]);
    store.deleteConnectionGroups.mockRejectedValue(new Error("persist failed"));
    const { confirmDeleteGroup, deleteConnectionGroup } = runtime(group, store, [group]);

    deleteConnectionGroup();
    deleteConnectionsWithGroup.value = true;
    await confirmDeleteGroup();

    expect(store.deleteConnectionGroups).toHaveBeenCalledWith(["group-1"], true);
    expect(store.disconnect).not.toHaveBeenCalled();
    expect(showDeleteGroupConfirm.value).toBe(true);
    expect(connectionGroupDeleteTargetSnapshot.value.map((target) => target.id)).toEqual(["group-1"]);
    expect(mocks.toast).toHaveBeenCalledWith('connection.saveFailed:{"message":"persist failed"}', 5000);
  });
});

describe("sidebar connection group disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarFormTarget.value = null;
  });

  it("recursively disconnects only connected connections under a collapsed group", async () => {
    const group = connectionGroupNode("group-parent");
    group.isExpanded = false;
    const store = connectionStore([group.id]);
    store.connectionIdsInGroups.mockReturnValue(["conn-1", "conn-2", "conn-3"]);
    store.connectedIds = new Set(["conn-1", "conn-3"]);
    const { canDisconnectConnectionGroup, connectionGroupDisconnectMenuLabel, disconnectConnectionGroup } = runtime(group, store);

    expect(canDisconnectConnectionGroup()).toBe(true);
    expect(connectionGroupDisconnectMenuLabel()).toBe('connectionGroup.closeConnections:{"count":2}');
    await disconnectConnectionGroup();

    expect(store.connectionIdsInGroups).toHaveBeenCalledWith(["group-parent"]);
    expect(store.disconnect.mock.calls).toEqual([["conn-1"], ["conn-3"]]);
    expect(store.removeConnections).not.toHaveBeenCalled();
    expect(store.deleteConnectionGroups).not.toHaveBeenCalled();
    expect(store.disconnectAndForgetConnectionPassword).not.toHaveBeenCalled();
  });

  it("disables and safely no-ops when the group has no connected connections", async () => {
    const group = connectionGroupNode("group-parent");
    const store = connectionStore([group.id]);
    store.connectionIdsInGroups.mockReturnValue(["conn-1", "conn-2"]);
    const { canDisconnectConnectionGroup, connectionGroupDisconnectMenuLabel, disconnectConnectionGroup } = runtime(group, store);

    expect(canDisconnectConnectionGroup()).toBe(false);
    expect(connectionGroupDisconnectMenuLabel()).toBe('connectionGroup.closeConnections:{"count":0}');
    await disconnectConnectionGroup();

    expect(store.disconnect).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("continues group disconnects after one connection fails", async () => {
    const group = connectionGroupNode("group-parent");
    const store = connectionStore([group.id]);
    store.connectionIdsInGroups.mockReturnValue(["conn-1", "conn-2"]);
    store.connectedIds = new Set(["conn-1", "conn-2"]);
    store.disconnect.mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(undefined);
    const { disconnectConnectionGroup } = runtime(group, store);

    await disconnectConnectionGroup();

    expect(store.disconnect.mock.calls).toEqual([["conn-1"], ["conn-2"]]);
    expect(mocks.toast).toHaveBeenCalledWith('connection.disconnectSelectedPartial:{"succeeded":1,"failed":1}', 5000);
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
