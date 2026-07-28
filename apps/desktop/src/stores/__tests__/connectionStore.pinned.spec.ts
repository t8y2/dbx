import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { treeNodePinKey } from "@/lib/app/pinnedItems";
import type { TreeNode } from "@/types/database";

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
