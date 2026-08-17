import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { treeNodePinKey } from "@/lib/app/pinnedItems";
import type { SidebarLayout, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function tableNode(name = "users"): TreeNode {
  return {
    id: `conn:db:public:${name}`,
    label: name,
    type: "table",
    connectionId: "conn",
    database: "db",
    schema: "public",
    tableName: name,
  };
}

function connectionGroupNode(id: string, children: TreeNode[] = []): TreeNode {
  return {
    id,
    label: id,
    type: "connection-group",
    isExpanded: true,
    children,
  };
}

describe("connectionStore pinned tree node removal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("does not pin a new table that reuses a deleted pinned table identity", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const deletedTable = tableNode();
    store.treeNodes = [
      {
        id: "conn",
        label: "Connection",
        type: "connection",
        connectionId: "conn",
        children: [deletedTable],
      },
    ];

    store.toggleTreeNodePin(deletedTable);
    expect(store.isTreeNodePinned(deletedTable)).toBe(true);

    store.removeTreeNode(deletedTable.id);
    const replacement = tableNode();
    store.treeNodes[0].children = [replacement];

    expect(store.isTreeNodePinned(replacement)).toBe(false);
  });

  it("removes pins and selection state for a deleted group and all of its nested groups", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({ saveSidebarLayout: vi.fn().mockResolvedValue(undefined) }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const child = connectionGroupNode("group-child");
    const parent = connectionGroupNode("group-parent", [child]);
    const layout: SidebarLayout = {
      groups: [
        { id: parent.id, name: "Parent", collapsed: false },
        { id: child.id, name: "Child", collapsed: false },
      ],
      order: [{ type: "group", id: parent.id, children: [{ type: "group", id: child.id, children: [] }] }],
    };
    store.sidebarLayout = layout;
    store.treeNodes = [parent];
    store.toggleTreeNodePin(parent);
    store.toggleTreeNodePin(child);
    store.selectedTreeNodeIds = [parent.id, child.id];
    store.selectedTreeNodeId = child.id;
    store.treeSelectionAnchorId = parent.id;
    store.connectionMultiSelectActive = true;

    await store.deleteConnectionGroup(parent.id);

    expect(store.sidebarLayout.groups).toEqual([]);
    expect(store.isTreeNodePinned(parent)).toBe(false);
    expect(store.isTreeNodePinned(child)).toBe(false);
    expect(store.selectedTreeNodeIds).toEqual([]);
    expect(store.selectedTreeNodeId).toBeNull();
    expect(store.treeSelectionAnchorId).toBeNull();
    expect(store.connectionMultiSelectActive).toBe(false);
  });

  it("keeps groups in memory when layout persistence fails", async () => {
    const saveSidebarLayout = vi.fn().mockRejectedValue(new Error("layout unavailable"));
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({ saveSidebarLayout }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const group = connectionGroupNode("group-1");
    const layout: SidebarLayout = {
      groups: [{ id: group.id, name: group.label, collapsed: false }],
      order: [{ type: "group", id: group.id, children: [] }],
    };
    store.sidebarLayout = layout;
    store.treeNodes = [group];

    await expect(store.deleteConnectionGroup(group.id)).rejects.toThrow("layout unavailable");

    expect(store.sidebarLayout).toStrictEqual(layout);
    expect(store.treeNodes).toEqual([group]);
    expect(saveSidebarLayout).toHaveBeenCalledWith({ groups: [], order: [] });
    expect(saveSidebarLayout).toHaveBeenLastCalledWith(layout);
  });

  it("restores saved connections when timeout settings cannot be updated", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      saveConnections,
      saveEditorSettings: vi.fn().mockRejectedValue(new Error("settings unavailable")),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settingsStore = useSettingsStore();
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = {
      id: "connection-1",
      name: "Connection",
      db_type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      username: "postgres",
      password: "",
      connect_timeout_inherit: true,
    } as const;
    store.connections = [connection];
    settingsStore.editorSettings.connectTimeoutInheritConnectionIds = [connection.id];

    await expect(store.removeConnection(connection.id)).rejects.toThrow("settings unavailable");

    expect(store.connections).toEqual([connection]);
    expect(settingsStore.editorSettings.connectTimeoutInheritConnectionIds).toEqual([connection.id]);
    expect(saveConnections).toHaveBeenCalledWith([]);
    expect(saveConnections).toHaveBeenLastCalledWith([connection]);
  });

  it("recounts parent objectCount from remaining children when a child is removed", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const view1 = {
      id: "conn:db:public:v1",
      label: "v1",
      type: "view" as const,
      connectionId: "conn",
      database: "db",
      schema: "public",
    };
    const view2 = {
      id: "conn:db:public:v2",
      label: "v2",
      type: "view" as const,
      connectionId: "conn",
      database: "db",
      schema: "public",
    };
    const loadMore = {
      id: "conn:db:public:__views:__load_more",
      label: "Load more",
      type: "load-more" as const,
      connectionId: "conn",
      database: "db",
    };
    const viewsGroup: TreeNode = {
      id: "conn:db:public:__views",
      label: "Views",
      type: "group-views",
      connectionId: "conn",
      database: "db",
      schema: "public",
      objectCount: 99,
      children: [view1, view2, loadMore],
    };
    store.treeNodes = [
      {
        id: "conn",
        label: "Connection",
        type: "connection",
        connectionId: "conn",
        children: [viewsGroup],
      },
    ];

    store.removeTreeNode(view1.id);

    expect(viewsGroup.children?.map((child) => child.id)).toEqual([view2.id, loadMore.id]);
    expect(viewsGroup.objectCount).toBe(1);
  });

  it("serializes desktop pin saves so an older reorder cannot overwrite the latest one", async () => {
    const savePinnedTreeNodeIds = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.doMock("@/lib/backend/api", () => ({ savePinnedTreeNodeIds }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const users = tableNode("users");
    const orders = tableNode("orders");
    store.treeNodes = [{ id: "conn", label: "Connection", type: "connection", connectionId: "conn", children: [users, orders] }];
    store.toggleTreeNodePin(users);
    store.toggleTreeNodePin(orders);
    await vi.waitFor(() => expect(savePinnedTreeNodeIds).toHaveBeenCalledTimes(2));

    savePinnedTreeNodeIds.mockClear();
    const snapshots: string[][] = [];
    const resolvers: Array<() => void> = [];
    savePinnedTreeNodeIds.mockImplementation((ids: string[]) => {
      snapshots.push([...ids]);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    });

    const usersKey = treeNodePinKey(users);
    const ordersKey = treeNodePinKey(orders);
    store.beginPinnedTreeNodeReorder(usersKey);
    expect(store.reorderPinnedTreeNodes(usersKey, ordersKey, "after")).toBe(true);
    store.endPinnedTreeNodeReorder();
    await vi.waitFor(() => expect(savePinnedTreeNodeIds).toHaveBeenCalledTimes(1));
    store.beginPinnedTreeNodeReorder(ordersKey);
    expect(store.reorderPinnedTreeNodes(ordersKey, usersKey, "after")).toBe(true);
    store.endPinnedTreeNodeReorder();

    expect(savePinnedTreeNodeIds).toHaveBeenCalledTimes(1);
    resolvers[0]!();
    await vi.waitFor(() => expect(savePinnedTreeNodeIds).toHaveBeenCalledTimes(2));
    resolvers[1]!();

    expect(snapshots).toEqual([
      [ordersKey, usersKey],
      [usersKey, ordersKey],
    ]);
  });

  it("caches active drag targets and invalidates them on tree changes and drag end", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const users = tableNode("users");
    const orders = tableNode("orders");
    const logs = tableNode("logs");
    store.treeNodes = [{ id: "conn", label: "Connection", type: "connection", connectionId: "conn", children: [users, orders, logs] }];
    store.toggleTreeNodePin(users);
    store.toggleTreeNodePin(orders);
    store.toggleTreeNodePin(logs);

    const usersKey = treeNodePinKey(users);
    const ordersKey = treeNodePinKey(orders);
    const logsKey = treeNodePinKey(logs);
    let schemaReads = 0;
    Object.defineProperty(orders, "schema", {
      configurable: true,
      get() {
        schemaReads += 1;
        return "public";
      },
    });

    store.beginPinnedTreeNodeReorder(usersKey);
    expect(store.isPinnedTreeNodeReorderTarget(ordersKey)).toBe(true);
    const readsAfterFirstLookup = schemaReads;
    expect(readsAfterFirstLookup).toBeGreaterThan(0);

    for (let index = 0; index < 100; index += 1) {
      expect(store.isPinnedTreeNodeReorderTarget(index % 2 === 0 ? ordersKey : logsKey)).toBe(true);
    }
    expect(schemaReads).toBe(readsAfterFirstLookup);

    store.treeNodes[0].children = [users, logs];
    store.treeNodes.push({ id: "other", label: "Other", type: "connection", connectionId: "other", children: [orders] });
    expect(store.isPinnedTreeNodeReorderTarget(ordersKey)).toBe(false);

    store.endPinnedTreeNodeReorder();
    expect(store.isPinnedTreeNodeReorderTarget(logsKey)).toBe(false);
  });

  it("moves a renamed pinned object to its new identity so recreating the old name is unpinned", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const users = tableNode("users");
    const accounts = tableNode("accounts");
    store.treeNodes = [{ id: "conn", label: "Connection", type: "connection", connectionId: "conn", children: [users] }];
    store.toggleTreeNodePin(users);

    store.treeNodes[0].children = [accounts];
    store.replacePinnedTreeNode(users, accounts);

    const recreatedUsers = tableNode("users");
    store.treeNodes[0].children = [accounts, recreatedUsers];

    expect(store.isTreeNodePinned(accounts)).toBe(true);
    expect(store.isTreeNodePinned(recreatedUsers)).toBe(false);
  });

  it("removes the old pin when a renamed replacement is not loaded in the sidebar", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const users = tableNode("users");
    const accounts = tableNode("accounts");
    store.treeNodes = [{ id: "conn", label: "Connection", type: "connection", connectionId: "conn", children: [users] }];
    store.toggleTreeNodePin(users);

    expect(store.replacePinnedTreeNode(users, accounts)).toBe(true);
    expect(store.isTreeNodePinned(users)).toBe(false);
    expect(store.isTreeNodePinned(accounts)).toBe(false);
  });
});
