import { describe, expect, it } from "vitest";
import { createFlatTreeIndex, flatTreeRowsChanged, flattenTree, mutateFlatTreeExpansion, replaceFlatTreeChildren, type FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode, TreeNodeType } from "@/types/database";

function item(id: string, type: TreeNodeType, depth: number, children?: TreeNode[]): FlatTreeNode {
  const node: TreeNode = { id, label: id, type, children };
  return { id, renderKey: `test:${depth}:${type}:${id}`, type, depth, node, poolType: type };
}

function createIndex(nodes: FlatTreeNode[]) {
  const databaseTypes = new Set<TreeNodeType>(["database", "redis-db", "mongo-db"]);
  return createFlatTreeIndex(nodes, {
    isSelectable: (node) => node.type !== "table-search-control",
    isBoundary: (type) => type === "connection" || type === "connection-group",
    isDatabaseContainer: (type) => databaseTypes.has(type),
    isSchemaContainer: (type) => type === "schema",
  });
}

describe("createFlatTreeIndex", () => {
  it("builds selection and lookup indexes in visible order", () => {
    const nodes = [item("connection", "connection", 0, [{ id: "child", label: "child", type: "database" }]), item("database", "database", 1), item("search", "table-search-control", 2), item("table", "table", 2)];

    const index = createIndex(nodes);

    expect(index.visibleNodes.map((node) => node.id)).toEqual(["connection", "database", "search", "table"]);
    expect(index.selectableVisibleNodes.map((node) => node.id)).toEqual(["connection", "database", "table"]);
    expect(index.selectableVisibleNodeIndexById.get("table")).toBe(2);
    expect(index.selectableVisibleNodeIndexById.has("search")).toBe(false);
    expect(index.flatNodeIndexById.get("table")).toBe(3);
    expect(index.nodeById.get("database")).toBe(nodes[1].node);
    expect(index.expandableNodeIds).toEqual(["connection"]);
  });

  it("prefers database containers and falls back to schemas per connection", () => {
    const nodes = [
      item("connection-a", "connection", 0),
      item("database-a", "database", 1),
      item("schema-a", "schema", 2),
      item("table-a", "table", 3),
      item("schema-b", "schema", 2),
      item("table-b", "table", 3),
      item("database-b", "database", 1),
      item("table-c", "table", 2),
      item("connection-b", "connection", 0),
      item("schema-c", "schema", 1),
      item("table-d", "table", 2),
    ];

    const index = createIndex(nodes);

    expect([...index.stickyContainerIndexByIndex]).toEqual([-1, 1, 1, 1, 1, 1, 6, 6, -1, 9, 9]);
    expect(index.nextDatabaseContainerIndexByIndex[1]).toBe(6);
    expect(index.nextDatabaseContainerIndexByIndex[6]).toBe(-1);
    expect(index.nextSchemaContainerIndexByIndex[2]).toBe(4);
    expect(index.nextSchemaContainerIndexByIndex[4]).toBe(-1);
    expect(index.nextSchemaContainerIndexByIndex[9]).toBe(-1);
  });

  it("keeps indexes isolated across connections without database containers", () => {
    const nodes = [item("connection-a", "connection", 0), item("schema-a", "schema", 1), item("table-a", "table", 2), item("connection-b", "connection", 0), item("table-b", "table", 1)];

    const index = createIndex(nodes);

    expect(index.stickyContainerIndexByIndex[2]).toBe(1);
    expect(index.stickyContainerIndexByIndex[4]).toBe(-1);
    expect(index.nextSchemaContainerIndexByIndex[1]).toBe(-1);
    expect(index.flatNodeIndexById.get("table-b")).toBe(4);
  });

  it("indexes a synthetic large visible tree in one pass", () => {
    const nodes: FlatTreeNode[] = [item("connection", "connection", 0)];
    for (let index = 0; index < 20_000; index += 1) {
      nodes.push(item(`table-${index}`, "table", 1));
    }

    const index = createIndex(nodes);

    expect(index.visibleNodes).toHaveLength(20_001);
    expect(index.flatNodeIndexById.get("table-19999")).toBe(20_000);
    expect(index.stickyContainerIndexByIndex).toHaveLength(20_001);
  });
});

describe("flat-tree range mutations", () => {
  it("expands and collapses only the affected descendant range", () => {
    const table: TreeNode = { id: "table", label: "table", type: "table" };
    const schema: TreeNode = { id: "schema", label: "schema", type: "schema", children: [table] };
    const database: TreeNode = { id: "database", label: "database", type: "database", children: [schema] };
    const connection: TreeNode = { id: "connection", label: "connection", type: "connection", isExpanded: true, children: [database] };
    const sibling: TreeNode = { id: "sibling", label: "sibling", type: "connection" };
    const initial = flattenTree([connection, sibling]);
    const connectionRenderKey = initial[0].renderKey;
    const databaseRenderKey = initial[1].renderKey;
    const siblingRenderKey = initial[2].renderKey;

    const expandedDatabase = mutateFlatTreeExpansion(initial, 1, database, true);
    expect(expandedDatabase.map((entry) => entry.id)).toEqual(["connection", "database", "schema", "sibling"]);
    expect(expandedDatabase[0].renderKey).toBe(connectionRenderKey);
    expect(expandedDatabase[1].renderKey).toBe(databaseRenderKey);
    expect(expandedDatabase.at(-1)?.renderKey).toBe(siblingRenderKey);
    expect(expandedDatabase.at(-1)?.node).toBe(sibling);

    const expandedSchema = mutateFlatTreeExpansion(expandedDatabase, 2, schema, true);
    expect(expandedSchema.map((entry) => entry.id)).toEqual(["connection", "database", "schema", "table", "sibling"]);
    expect(expandedSchema[0].renderKey).toBe(connectionRenderKey);
    expect(expandedSchema[1].renderKey).toBe(databaseRenderKey);
    expect(expandedSchema.at(-1)?.renderKey).toBe(siblingRenderKey);

    const collapsedDatabase = mutateFlatTreeExpansion(expandedSchema, 1, database, false);
    expect(collapsedDatabase.map((entry) => entry.id)).toEqual(["connection", "database", "sibling"]);
    expect(collapsedDatabase.map((entry) => entry.renderKey)).toEqual([connectionRenderKey, databaseRenderKey, siblingRenderKey]);
    expect(collapsedDatabase[2].node).toBe(sibling);
  });

  it("atomically replaces refreshed children and preserves surrounding rows", () => {
    const oldTable: TreeNode = { id: "old-table", label: "old-table", type: "table" };
    const database: TreeNode = { id: "database", label: "database", type: "database", isExpanded: true, children: [oldTable] };
    const connection: TreeNode = { id: "connection", label: "connection", type: "connection", isExpanded: true, children: [database] };
    const sibling: TreeNode = { id: "sibling", label: "sibling", type: "connection" };
    const initial = flattenTree([connection, sibling]);
    const newTable: TreeNode = { id: "new-table", label: "new-table", type: "table" };
    database.children = [newTable];

    const refreshed = replaceFlatTreeChildren(initial, 1, database);

    expect(refreshed.map((entry) => entry.id)).toEqual(["connection", "database", "new-table", "sibling"]);
    expect(refreshed[0].renderKey).toBe(initial[0].renderKey);
    expect(refreshed[1].renderKey).toBe(initial[1].renderKey);
    expect(refreshed[3].renderKey).toBe(initial[3].renderKey);
    expect(refreshed[2].renderKey).not.toBe(initial[2].renderKey);
    expect(refreshed[0]).toBe(initial[0]);
    expect(refreshed[3]).toBe(initial[3]);
  });

  it("falls back to an unchanged copy when the indexed parent no longer matches", () => {
    const nodes = [item("connection", "connection", 0)];
    const other: TreeNode = { id: "other", label: "other", type: "connection", isExpanded: true, children: [] };

    const result = replaceFlatTreeChildren(nodes, 0, other);

    expect(result).toEqual(nodes);
    expect(result).not.toBe(nodes);
  });
});

describe("flat-tree render identities", () => {
  it("detects same-length table-search row replacements for #6951", () => {
    const previous = [item("table-a", "table", 1), item("table-b", "table", 1)];
    const unchanged = previous.map((entry) => ({ ...entry }));
    const next = [item("table-c", "table", 1), item("table-b", "table", 1)];

    expect(flatTreeRowsChanged(unchanged, previous)).toBe(false);
    expect(flatTreeRowsChanged(next, previous)).toBe(true);
  });

  it("isolates equal business ids that belong to different lineages", () => {
    const collidingId = "connection:a:b";
    const collidingSchemaId = "connection:a:b:c";
    const directDatabaseSchema: TreeNode = { id: collidingSchemaId, label: "c", type: "schema" };
    const directDatabase: TreeNode = { id: collidingId, label: "a:b", type: "database", isExpanded: true, children: [directDatabaseSchema] };
    const schema: TreeNode = { id: collidingId, label: "b", type: "schema" };
    const sameTypeSchema: TreeNode = { id: collidingSchemaId, label: "b:c", type: "schema" };
    const parentDatabase: TreeNode = { id: "connection:a", label: "a", type: "database", isExpanded: true, children: [schema, sameTypeSchema] };
    const connection: TreeNode = { id: "connection", label: "connection", type: "connection", isExpanded: true, children: [directDatabase, parentDatabase] };

    const flattened = flattenTree([connection]);
    const collisions = flattened.filter((entry) => entry.id === collidingId);
    const sameTypeCollisions = flattened.filter((entry) => entry.id === collidingSchemaId);

    expect(collisions.map((entry) => entry.type)).toEqual(["database", "schema"]);
    expect(new Set(collisions.map((entry) => entry.renderKey))).toHaveLength(2);
    expect(sameTypeCollisions.map((entry) => entry.type)).toEqual(["schema", "schema"]);
    expect(new Set(sameTypeCollisions.map((entry) => entry.renderKey))).toHaveLength(2);
    expect(new Set(flattened.map((entry) => entry.renderKey))).toHaveLength(flattened.length);
  });

  it("keeps unique and default database business identities unchanged", () => {
    const defaultDatabase: TreeNode = { id: "connection:", label: "Default", type: "database" };
    const namedDatabase: TreeNode = { id: "connection:app", label: "app", type: "database" };
    const connection: TreeNode = { id: "connection", label: "connection", type: "connection", isExpanded: true, children: [defaultDatabase, namedDatabase] };

    const flattened = flattenTree([connection]);

    expect(flattened.map(({ id, type, poolType }) => ({ id, type, poolType }))).toEqual([
      { id: "connection", type: "connection", poolType: "connection" },
      { id: "connection:", type: "database", poolType: "database" },
      { id: "connection:app", type: "database", poolType: "database" },
    ]);
    expect(new Set(flattened.map((entry) => entry.renderKey))).toHaveLength(flattened.length);
  });
});
