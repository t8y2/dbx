import { describe, expect, it } from "vitest";
import { orderItemsByPinnedTreeNodeOrder, removePinnedTreeNodesFromOrder, treeNodePinIdentity, treeNodePinKey } from "@/lib/app/pinnedItems";
import { buildObjectBrowserRows, canonicalizeObjectBrowserPinnedTreeNodeIdentity, objectBrowserRowLegacyPinnedTreeNodeIds, objectBrowserRowMatchesPinnedTreeNode, sortObjectBrowserRows, type ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import type { TreeNode } from "@/types/database";

describe("buildObjectBrowserRows", () => {
  it("preserves a resolved SQLite attached-database alias on every row", () => {
    const rows = buildObjectBrowserRows({
      objects: [{ name: "events", object_type: "TABLE" }],
      database: "analytics",
      fallbackSchema: "analytics",
      rowSchema: "analytics",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.schema).toBe("analytics");
  });

  it("keeps non-schema database rows unqualified when no row namespace is resolved", () => {
    const rows = buildObjectBrowserRows({
      objects: [{ name: "events", object_type: "TABLE" }],
      database: "app",
      fallbackSchema: "app",
    });

    expect(rows[0]?.schema).toBeUndefined();
  });
});

describe("Object Browser pinned ordering", () => {
  const context = { connectionId: "conn", database: "app", schema: "public" };

  function tableNode(name: string, schema = "public"): TreeNode {
    return {
      id: `conn:app:${schema}:tables:${name}`,
      label: name,
      type: "table",
      connectionId: "conn",
      database: "app",
      schema,
    };
  }

  function orderRows(rows: ObjectBrowserRow[], pinnedNodes: TreeNode[], extraPinnedKeys: string[] = []): ObjectBrowserRow[] {
    const pinnedOrder = [...extraPinnedKeys, ...pinnedNodes.map(treeNodePinKey)];
    return orderItemsByPinnedTreeNodeOrder(rows, pinnedOrder, (row, identity) => objectBrowserRowMatchesPinnedTreeNode(row, identity, context));
  }

  it("uses the sidebar's persisted custom pin order before the selected name sort", () => {
    const rows = buildObjectBrowserRows({
      objects: ["a1", "a2", "a3", "a4", "a5", "aaa"].map((name) => ({ name, object_type: "TABLE", schema: "public" })),
      database: "app",
      fallbackSchema: "public",
      rowSchema: "public",
    });
    const sorted = sortObjectBrowserRows(rows, "name", "asc");
    const pinnedNodes = ["aaa", "a5", "a4", "a3", "a2", "a1"].map((name) => tableNode(name));

    const ordered = orderRows(sorted, pinnedNodes, [treeNodePinKey({ ...tableNode("other"), connectionId: "other-connection" })]);

    expect(ordered.map((row) => row.name)).toEqual(["aaa", "a5", "a4", "a3", "a2", "a1"]);
  });

  it("keeps unpinned rows in the Object Browser's selected column order", () => {
    const rows: ObjectBrowserRow[] = [
      { id: "a1", name: "a1", displayName: "a1", schema: "public", type: "TABLE", totalBytes: 30 },
      { id: "a2", name: "a2", displayName: "a2", schema: "public", type: "TABLE", totalBytes: 40 },
      { id: "a3", name: "a3", displayName: "a3", schema: "public", type: "TABLE", totalBytes: 10 },
      { id: "a4", name: "a4", displayName: "a4", schema: "public", type: "TABLE", totalBytes: 20 },
    ];
    const sorted = sortObjectBrowserRows(rows, "totalBytes", "desc");

    const ordered = orderRows(sorted, [tableNode("a3"), tableNode("a1")]);

    expect(ordered.map((row) => row.name)).toEqual(["a3", "a1", "a2", "a4"]);
  });

  it("matches a sidebar database child when Object Browser reports the database name as its schema", () => {
    const row: ObjectBrowserRow = { id: "a1", name: "a1", displayName: "a1", schema: "app", type: "TABLE" };
    const sidebarNode = tableNode("a1", "");

    expect(objectBrowserRowMatchesPinnedTreeNode(row, treeNodePinIdentity(sidebarNode), { connectionId: "conn", database: "app", schema: "app" })).toBe(true);
  });

  it("clears the database-as-schema alias when an Object Browser object is deleted", () => {
    const sidebarNode = tableNode("events", "");
    const objectBrowserNode: TreeNode = { ...sidebarNode, id: "object-browser:app:events", schema: "app" };
    const canonicalize = canonicalizeObjectBrowserPinnedTreeNodeIdentity({ connectionId: "conn", database: "app" });

    const remainingOrder = removePinnedTreeNodesFromOrder([treeNodePinKey(sidebarNode)], [objectBrowserNode], canonicalize);

    expect(remainingOrder).toEqual([]);
  });

  it("reconstructs legacy sidebar IDs for an unloaded Object Browser row", () => {
    const row: ObjectBrowserRow = { id: "object-browser:events:0", name: "events", displayName: "events", schema: "public", type: "TABLE" };
    const ids = objectBrowserRowLegacyPinnedTreeNodeIds(row, { connectionId: "conn", database: "app", schema: "public", sidebarParentId: "conn:app:public" });

    expect(ids).toEqual(expect.arrayContaining(["conn:app:public:events", "conn:app:public:__tables:public:events"]));
  });

  it("does not confuse same-name objects across schemas or routine overloads", () => {
    const tableRow: ObjectBrowserRow = { id: "orders", name: "orders", displayName: "orders", schema: "public", type: "TABLE" };
    expect(objectBrowserRowMatchesPinnedTreeNode(tableRow, treeNodePinIdentity(tableNode("orders", "archive")), context)).toBe(false);
    expect(objectBrowserRowMatchesPinnedTreeNode(tableRow, treeNodePinIdentity(tableNode("orders", "public")), context)).toBe(true);

    const routineRow: ObjectBrowserRow = { id: "run-int", name: "run", displayName: "run(integer)", schema: "public", type: "FUNCTION", signature: "integer" };
    const routineNode: TreeNode = {
      id: "conn:app:public:functions:run:text",
      label: "run(text)",
      objectName: "run",
      signature: "text",
      type: "function",
      connectionId: "conn",
      database: "app",
      schema: "public",
    };
    expect(objectBrowserRowMatchesPinnedTreeNode(routineRow, treeNodePinIdentity(routineNode), context)).toBe(false);
    expect(objectBrowserRowMatchesPinnedTreeNode(routineRow, treeNodePinIdentity({ ...routineNode, id: "conn:app:public:functions:run:integer", label: "run(integer)", signature: "integer" }), context)).toBe(true);
  });
});
