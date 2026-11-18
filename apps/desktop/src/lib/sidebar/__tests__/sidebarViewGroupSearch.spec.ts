import { describe, expect, it } from "vitest";
import { buildSidebarIndexedTableNodes, filterLocallySearchedTables, localTableSearchParentTypes } from "@/lib/sidebar/sidebarSearchTree";
import { insertSidebarTableSearchControls } from "@/lib/sidebar/sidebarTableSearchControl";
import type { FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode } from "@/types/database";

function groupNode(type: TreeNode["type"], children: TreeNode[]): TreeNode {
  return {
    id: `conn:db@${type}`,
    label: type,
    type,
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children,
  };
}

function child(type: TreeNode["type"], name: string): TreeNode {
  return { id: `conn:db@${type}:${name}`, label: name, type, connectionId: "conn", database: "app" };
}

function flat(nodes: TreeNode[], depth = 0): FlatTreeNode[] {
  const out: FlatTreeNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, id: node.id, renderKey: node.id, type: node.type, poolType: `${node.type}:${node.id}` });
    if (node.children?.length) out.push(...flat(node.children, depth + 1));
  }
  return out;
}

describe("sidebar search for view groups (#12901)", () => {
  it("offers the search control on grouped views and materialized views", () => {
    const tree = [groupNode("group-tables", [child("table", "orders")]), groupNode("group-views", [child("view", "active_users")]), groupNode("group-materialized-views", [child("materialized_view", "daily_sales")])];
    const withControls = insertSidebarTableSearchControls(flat(tree), {
      enabled: true,
      sidebarObjectDisplay: "grouped",
      activeQueries: {},
    });
    const controlParents = withControls.filter(({ node }) => node.type === "table-search-control").map(({ node }) => node.tableSearchParentId);
    expect(controlParents).toHaveLength(3);
    expect(controlParents).toContain("conn:db@group-tables");
    expect(controlParents).toContain("conn:db@group-views");
    expect(controlParents).toContain("conn:db@group-materialized-views");
  });

  it("filters grouped view children by the local query, case-insensitively", () => {
    const views = groupNode("group-views", [child("view", "ActiveUsers"), child("view", "archived_sessions")]);
    const filtered = filterLocallySearchedTables([views], {
      enabled: true,
      queries: { "conn:db@group-views": "active" },
      indexedResults: {},
    });
    expect(filtered[0]?.children?.map((node) => node.label)).toEqual(["ActiveUsers"]);
    // Clearing the query restores the full list.
    const restored = filterLocallySearchedTables([views], { enabled: true, queries: { "conn:db@group-views": "" }, indexedResults: {} });
    expect(restored[0]?.children).toHaveLength(2);
  });

  it("restores partition hierarchy from indexed parent metadata", () => {
    const nodes = buildSidebarIndexedTableNodes({
      parentNodeId: "conn:db@group-tables",
      nodeType: "group-tables",
      connectionId: "conn",
      database: "app",
      schema: "public",
      entries: [
        { name: "orders", table_type: "BASE TABLE" },
        { name: "orders_2025", table_type: "BASE TABLE", parent_schema: "public", parent_name: "orders" },
      ],
    });

    expect(nodes.map((node) => node.label)).toEqual(["orders"]);
    expect(nodes[0]?.children?.find((node) => node.type === "group-partitions")?.children?.map((node) => node.label)).toEqual(["orders_2025"]);
  });

  it("restores partition hierarchy for database-level indexed results", () => {
    const nodes = buildSidebarIndexedTableNodes({
      parentNodeId: "conn:db",
      nodeType: "database",
      connectionId: "conn",
      database: "app",
      entries: [
        { name: "orders", table_type: "BASE TABLE", schema: "public" },
        { name: "orders_2025", table_type: "BASE TABLE", schema: "public", parent_schema: "public", parent_name: "orders" },
      ],
    });

    expect(nodes.map((node) => node.label)).toEqual(["orders"]);
    expect(nodes[0]?.children?.find((node) => node.type === "group-partitions")?.children?.map((node) => node.label)).toEqual(["orders_2025"]);
  });

  it("registers the view group types as local search parents", () => {
    expect(localTableSearchParentTypes.has("group-views")).toBe(true);
    expect(localTableSearchParentTypes.has("group-materialized-views")).toBe(true);
  });

  it("matches a schema-qualified query only inside the named schema (#14316)", () => {
    const schema = (name: string, tables: string[]): TreeNode => ({
      id: `conn:db@schema:${name}`,
      label: name,
      type: "schema",
      connectionId: "conn",
      database: "app",
      schema: name,
      isExpanded: true,
      children: tables.map((table) => ({ ...child("table", table), schema: name })),
    });
    const tree = [schema("public", ["users", "orders"]), schema("audit", ["users"])];

    const usersInPublic = filterLocallySearchedTables(tree, { enabled: true, queries: { "conn:db@schema:public": "public.users", "conn:db@schema:audit": "public.users" }, indexedResults: {} });
    expect(usersInPublic[0]?.children?.map((node) => node.label)).toEqual(["users"]);
    // The other schema lists its own "users" too, but the qualifier only names public.
    expect(usersInPublic[1]?.children).toEqual([]);

    // A plain query still matches every schema by name.
    const plain = filterLocallySearchedTables(tree, { enabled: true, queries: { "conn:db@schema:public": "users" }, indexedResults: {} });
    expect(plain[0]?.children?.map((node) => node.label)).toEqual(["users"]);
  });

  it("matches a schema-qualified query against indexed entries by their own schema (#14316)", () => {
    const databaseNode: TreeNode = { id: "conn:db", label: "app", type: "database", connectionId: "conn", database: "app", isExpanded: true, children: [] };
    const filtered = filterLocallySearchedTables([databaseNode], {
      enabled: true,
      queries: { "conn:db": "public.users" },
      indexedResults: {
        "conn:db": [
          { name: "users", table_type: "TABLE", schema: "public" },
          { name: "users", table_type: "TABLE", schema: "audit" },
        ],
      },
    });
    expect(filtered[0]?.children?.map((node) => node.label)).toEqual(["users"]);
  });

  it("never reads a partitioned parent's schema as the object's schema (#14316 review)", () => {
    // Drivers put the partitioned parent table's schema in `parent_schema`, so an
    // entry that only has one must not satisfy a `public.users` query: that is how
    // ordinary tables went missing and partition children matched the wrong schema.
    const databaseNode: TreeNode = { id: "conn:db", label: "app", type: "database", connectionId: "conn", database: "app", isExpanded: true, children: [] };
    const filtered = filterLocallySearchedTables([databaseNode], {
      enabled: true,
      queries: { "conn:db": "public.users" },
      indexedResults: {
        "conn:db": [{ name: "users", table_type: "TABLE", parent_schema: "public" }],
      },
    });
    expect(filtered[0]?.children).toEqual([]);
  });

  it("matches a database-qualified query on flat engines through the node's database (#14316)", () => {
    // MySQL-style scope: no node schema, index rows stay unattributed (a stamped
    // schema would break child-id identity with the live tree). The qualifier
    // still matches via the parent node's own database.
    const databaseNode: TreeNode = { id: "conn:db", label: "dbx_test", type: "database", connectionId: "conn", database: "dbx_test", isExpanded: true, children: [] };
    const filtered = filterLocallySearchedTables([databaseNode], {
      enabled: true,
      queries: { "conn:db": "dbx_test.users" },
      indexedResults: {
        "conn:db": [
          { name: "users", table_type: "TABLE" },
          { name: "orders", table_type: "TABLE" },
        ],
      },
    });
    expect(filtered[0]?.children?.map((node) => node.label)).toEqual(["users"]);

    const otherQualifier = filterLocallySearchedTables([databaseNode], {
      enabled: true,
      queries: { "conn:db": "other.users" },
      indexedResults: {
        "conn:db": [{ name: "users", table_type: "TABLE" }],
      },
    });
    expect(otherQualifier[0]?.children).toEqual([]);
  });
});
