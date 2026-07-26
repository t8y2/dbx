import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import {
  inheritNaturalTreeNodeOrder,
  migrateLegacyPinnedTreeNodeIds,
  migrateLegacyPinnedTreeNodeOrder,
  removePinnedTreeNodesFromOrder,
  reorderPinnedTreeNodeOrder,
  replacePinnedTreeNodeInOrder,
  syncPinnedTreeNodeStateInPlace,
  treeNodePinKey,
  updatePinnedTreeNodeInPlace,
} from "@/lib/app/pinnedItems";
import { buildTreeNodesFromLayout } from "@/lib/sidebar/sidebarLayout";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";

describe("sidebar pinned tree nodes", () => {
  it("reorders the pinned node within its parent", () => {
    const tree: TreeNode[] = [
      {
        id: "conn",
        label: "Connection",
        type: "connection",
        children: [
          { id: "conn:db:a", label: "A", type: "database" },
          { id: "conn:db:b", label: "B", type: "database" },
        ],
      },
    ];

    expect(updatePinnedTreeNodeInPlace(tree, tree[0].children![1], true)).toBe("siblings");

    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:b", "conn:db:a"]);
    expect(tree[0].children?.[0].pinned).toBe(true);
  });

  it("restores the original sibling order after unpinning", () => {
    const children: TreeNode[] = [
      { id: "conn:db:a", label: "A", type: "database" },
      { id: "conn:db:b", label: "B", type: "database" },
      { id: "conn:db:c", label: "C", type: "database" },
    ];
    const tree: TreeNode[] = [{ id: "conn", label: "Connection", type: "connection", children }];

    updatePinnedTreeNodeInPlace(tree, children[1], true);
    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:b", "conn:db:a", "conn:db:c"]);

    updatePinnedTreeNodeInPlace(tree, children[1], false);
    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:a", "conn:db:b", "conn:db:c"]);
  });

  it("restores unpinned nodes while keeping other pinned nodes first", () => {
    const children: TreeNode[] = [
      { id: "conn:db:a", label: "A", type: "database" },
      { id: "conn:db:b", label: "B", type: "database" },
      { id: "conn:db:c", label: "C", type: "database" },
    ];
    const tree: TreeNode[] = [{ id: "conn", label: "Connection", type: "connection", children }];

    updatePinnedTreeNodeInPlace(tree, children[1], true);
    updatePinnedTreeNodeInPlace(tree, children[2], true);
    updatePinnedTreeNodeInPlace(tree, children[1], false);

    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:c", "conn:db:a", "conn:db:b"]);

    updatePinnedTreeNodeInPlace(tree, children[2], false);
    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:a", "conn:db:b", "conn:db:c"]);
  });

  it("reorders pinned root nodes in place", () => {
    const tree: TreeNode[] = [
      { id: "group-a", label: "A", type: "connection-group" },
      { id: "group-b", label: "B", type: "connection-group" },
    ];

    expect(updatePinnedTreeNodeInPlace(tree, tree[1], true)).toBe("root");

    expect(tree.map((node) => node.id)).toEqual(["group-b", "group-a"]);
    expect(tree[0].pinned).toBe(true);
  });

  it("restores the original root order after unpinning", () => {
    const tree: TreeNode[] = [
      { id: "group-a", label: "A", type: "connection-group" },
      { id: "group-b", label: "B", type: "connection-group" },
      { id: "group-c", label: "C", type: "connection-group" },
    ];
    const groupB = tree[1];

    updatePinnedTreeNodeInPlace(tree, groupB, true);
    updatePinnedTreeNodeInPlace(tree, groupB, false);

    expect(tree.map((node) => node.id)).toEqual(["group-a", "group-b", "group-c"]);
  });

  it("restores order for Vue reactive tree nodes", () => {
    const tree = reactive<TreeNode[]>([
      { id: "group-a", label: "A", type: "connection-group" },
      { id: "group-b", label: "B", type: "connection-group" },
      { id: "group-c", label: "C", type: "connection-group" },
    ]);
    const groupB = tree[1];

    updatePinnedTreeNodeInPlace(tree, groupB, true);
    updatePinnedTreeNodeInPlace(tree, groupB, false);

    expect(tree.map((node) => node.id)).toEqual(["group-a", "group-b", "group-c"]);
  });

  it("restores hidden children and keeps appended children in load order", () => {
    const tableA: TreeNode = { id: "table-a", label: "A", type: "table", connectionId: "conn", database: "db" };
    const tableB: TreeNode = { id: "table-b", label: "B", type: "table", connectionId: "conn", database: "db" };
    const tableC: TreeNode = { id: "table-c", label: "C", type: "table", connectionId: "conn", database: "db" };
    const database: TreeNode = { id: "db", label: "Database", type: "database", hiddenChildren: [tableA, tableB] };
    const tree = [database];

    syncPinnedTreeNodeStateInPlace(tree, new Set([treeNodePinKey(tableB)]));
    database.hiddenChildren!.push(tableC);
    syncPinnedTreeNodeStateInPlace(tree, new Set());

    expect(database.hiddenChildren?.map((node) => node.id)).toEqual(["table-a", "table-b", "table-c"]);
  });

  it("scopes duplicate node ids by database when pinning", () => {
    const databaseA: TreeNode = {
      id: "conn:a",
      label: "A",
      type: "database",
      children: [{ id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "a" }],
    };
    const databaseB: TreeNode = {
      id: "conn:b",
      label: "B",
      type: "database",
      children: [{ id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "b" }],
    };
    const tree: TreeNode[] = [{ id: "conn", label: "Connection", type: "connection", children: [databaseA, databaseB] }];

    expect(updatePinnedTreeNodeInPlace(tree, databaseA.children![0], true)).toBe("siblings");

    expect(databaseA.children![0].pinned).toBe(true);
    expect(databaseB.children![0].pinned).not.toBe(true);
  });

  it("clears stale legacy duplicate pins after switching to scoped keys", () => {
    const tableA: TreeNode = { id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "a", pinned: true };
    const tableB: TreeNode = { id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "b", pinned: true };
    const tree: TreeNode[] = [
      { id: "conn:a", label: "A", type: "database", children: [tableA] },
      { id: "conn:b", label: "B", type: "database", children: [tableB] },
    ];

    syncPinnedTreeNodeStateInPlace(tree, new Set([treeNodePinKey(tableA)]));

    expect(tableA.pinned).toBe(true);
    expect(tableB.pinned).toBe(false);
  });

  it("removes a deleted table pin so a recreated or renamed table does not inherit it", () => {
    const deletedTable: TreeNode = { id: "conn:db:public:users", label: "users", type: "table", connectionId: "conn", database: "db", schema: "public", tableName: "users" };
    const anotherTable: TreeNode = { id: "conn:db:public:orders", label: "orders", type: "table", connectionId: "conn", database: "db", schema: "public", tableName: "orders" };
    const pinOrder = [treeNodePinKey(deletedTable), treeNodePinKey(anotherTable)];

    const remainingOrder = removePinnedTreeNodesFromOrder(pinOrder, [{ ...deletedTable, id: "object-browser-row-id" }]);
    const recreatedTable: TreeNode = { ...deletedTable };
    const renamedTable: TreeNode = { ...anotherTable, id: deletedTable.id, label: deletedTable.label, tableName: deletedTable.tableName };

    expect(remainingOrder).toEqual([treeNodePinKey(anotherTable)]);
    expect(remainingOrder).not.toContain(treeNodePinKey(recreatedTable));
    expect(remainingOrder).not.toContain(treeNodePinKey(renamedTable));
  });

  it("moves a renamed pin to the new identity without retaining the old name", () => {
    const users: TreeNode = { id: "conn:db:public:users", label: "users", type: "table", connectionId: "conn", database: "db", schema: "public", tableName: "users" };
    const orders: TreeNode = { id: "conn:db:public:orders", label: "orders", type: "table", connectionId: "conn", database: "db", schema: "public", tableName: "orders" };
    const accounts: TreeNode = { ...users, id: "conn:db:public:accounts", label: "accounts", tableName: "accounts" };

    const renamedOrder = replacePinnedTreeNodeInOrder([treeNodePinKey(users), treeNodePinKey(orders)], users, accounts);

    expect(renamedOrder).toEqual([treeNodePinKey(accounts), treeNodePinKey(orders)]);
    expect(renamedOrder).not.toContain(treeNodePinKey(users));
  });

  it("migrates a legacy id once instead of pinning every colliding node", () => {
    const tableA: TreeNode = { id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "a" };
    const tableB: TreeNode = { id: "duplicate-table-id", label: "users", type: "table", connectionId: "conn", database: "b" };

    const migrated = migrateLegacyPinnedTreeNodeIds([tableA, tableB], new Set(["duplicate-table-id"]));

    expect(migrated.changed).toBe(true);
    expect(migrated.ids).toEqual(new Set([treeNodePinKey(tableA)]));
  });

  it("uses the persisted order for pinned siblings", () => {
    const nodeA: TreeNode = { id: "db-a", label: "A", type: "database", connectionId: "conn", database: "a" };
    const nodeB: TreeNode = { id: "db-b", label: "B", type: "database", connectionId: "conn", database: "b" };
    const nodeC: TreeNode = { id: "db-c", label: "C", type: "database", connectionId: "conn", database: "c" };
    const nodes = [nodeA, nodeB, nodeC];
    const order = [treeNodePinKey(nodeC), treeNodePinKey(nodeA)];

    syncPinnedTreeNodeStateInPlace(nodes, new Set(order), order);

    expect(nodes.map((node) => node.id)).toEqual(["db-c", "db-a", "db-b"]);
  });

  it("keeps the fixed default database before manually pinned siblings", () => {
    const nodeA: TreeNode = { id: "db-a", label: "A", type: "database", connectionId: "conn", database: "a" };
    const defaultNode: TreeNode = { id: "db-default", label: "Default", type: "database", connectionId: "conn", database: "default" };
    const nodeC: TreeNode = { id: "db-c", label: "C", type: "database", connectionId: "conn", database: "c" };
    const nodes = [nodeA, defaultNode, nodeC];
    const order = [treeNodePinKey(nodeC), treeNodePinKey(nodeA)];

    syncPinnedTreeNodeStateInPlace(nodes, new Set(order), order, (node) => node.id === defaultNode.id);

    expect(nodes.map((node) => node.id)).toEqual(["db-default", "db-c", "db-a"]);
    expect(defaultNode.pinned).toBe(false);
  });

  it("keeps the fixed default database first even when it is also manually pinned", () => {
    const nodeA: TreeNode = { id: "db-a", label: "A", type: "database", connectionId: "conn", database: "a" };
    const defaultNode: TreeNode = { id: "db-default", label: "Default", type: "database", connectionId: "conn", database: "default" };
    const nodeC: TreeNode = { id: "db-c", label: "C", type: "database", connectionId: "conn", database: "c" };
    const nodes = [nodeA, defaultNode, nodeC];
    const order = [treeNodePinKey(nodeC), treeNodePinKey(nodeA), treeNodePinKey(defaultNode)];

    syncPinnedTreeNodeStateInPlace(nodes, new Set(order), order, (node) => node.id === defaultNode.id);

    expect(nodes.map((node) => node.id)).toEqual(["db-default", "db-c", "db-a"]);
    expect(defaultNode.pinned).toBe(true);
  });

  it("reorders pinned keys before and after a sibling without dropping unrelated keys", () => {
    const initial = ["scope:a", "other:x", "scope:b", "other:y", "scope:c"];

    const before = reorderPinnedTreeNodeOrder(initial, "scope:c", "scope:a", "before");
    expect(before).toEqual(["scope:c", "scope:a", "other:x", "scope:b", "other:y"]);

    const after = reorderPinnedTreeNodeOrder(before, "scope:c", "scope:b", "after");
    expect(after).toEqual(["scope:a", "other:x", "scope:b", "scope:c", "other:y"]);
    expect(after.filter((key) => key.startsWith("other:"))).toEqual(["other:x", "other:y"]);
  });

  it("places a newly appended pin last within its sibling pin section", () => {
    const nodeA: TreeNode = { id: "db-a", label: "A", type: "database", connectionId: "conn", database: "a" };
    const nodeB: TreeNode = { id: "db-b", label: "B", type: "database", connectionId: "conn", database: "b" };
    const nodeC: TreeNode = { id: "db-c", label: "C", type: "database", connectionId: "conn", database: "c" };
    const nodes = [nodeA, nodeB, nodeC];
    const order = [treeNodePinKey(nodeC), treeNodePinKey(nodeA), treeNodePinKey(nodeB)];

    syncPinnedTreeNodeStateInPlace(nodes, new Set(order), order);

    expect(nodes.map((node) => node.id)).toEqual(["db-c", "db-a", "db-b"]);
  });

  it("migrates a legacy pin key in place without changing persisted order", () => {
    const node: TreeNode = { id: "legacy-table", label: "users", type: "table", connectionId: "conn", database: "db" };

    const migrated = migrateLegacyPinnedTreeNodeOrder([node], ["before", node.id, "after"]);

    expect(migrated.changed).toBe(true);
    expect(migrated.order).toEqual(["before", treeNodePinKey(node), "after"]);
  });

  it("removes explicitly supplied legacy keys for an unloaded node", () => {
    const node: TreeNode = { id: "object-browser:app:events", label: "events", type: "table", connectionId: "conn", database: "app", schema: "public" };
    const legacyKey = "conn:app:public:__tables:public:events";

    expect(removePinnedTreeNodesFromOrder([legacyKey, "unrelated"], [node], undefined, [legacyKey])).toEqual(["unrelated"]);
  });

  it("replaces an explicitly supplied legacy key without losing its position", () => {
    const oldNode: TreeNode = { id: "object-browser:app:events", label: "events", type: "table", connectionId: "conn", database: "app", schema: "public" };
    const newNode: TreeNode = { id: "conn:app:public:__tables:public:renamed", label: "renamed", type: "table", connectionId: "conn", database: "app", schema: "public" };
    const legacyKey = "conn:app:public:__tables:public:events";

    expect(replacePinnedTreeNodeInOrder(["before", legacyKey, "after"], oldNode, newNode, undefined, [legacyKey])).toEqual(["before", treeNodePinKey(newNode), "after"]);
  });

  it("applies pinned state to connection groups when rebuilding from layout", () => {
    const layout: SidebarLayout = {
      groups: [
        { id: "group-a", name: "A", collapsed: false },
        { id: "group-b", name: "B", collapsed: false },
      ],
      order: [
        { type: "group", id: "group-a", children: [] },
        { type: "group", id: "group-b", children: [] },
      ],
    };
    const connections: ConnectionConfig[] = [];

    const nodes = buildTreeNodesFromLayout(layout, connections, new Set(["group-b"]));

    expect(nodes.map((node) => node.id)).toEqual(["group-b", "group-a"]);
    expect(nodes[0].pinned).toBe(true);

    syncPinnedTreeNodeStateInPlace(nodes, new Set());
    expect(nodes.map((node) => node.id)).toEqual(["group-a", "group-b"]);
  });

  it("retains the latest layout order through rebuilt node clones", () => {
    const layout: SidebarLayout = {
      groups: [
        { id: "group-a", name: "A", collapsed: false },
        { id: "group-b", name: "B", collapsed: false },
      ],
      order: [
        { type: "group", id: "group-a", children: [] },
        { type: "group", id: "group-b", children: [] },
      ],
    };
    const built = buildTreeNodesFromLayout(layout, [], new Set(["group-b"]));
    const rebuilt = built.map((node) => inheritNaturalTreeNodeOrder(node, { ...node }));

    syncPinnedTreeNodeStateInPlace(rebuilt, new Set());

    expect(rebuilt.map((node) => node.id)).toEqual(["group-a", "group-b"]);
  });
});
