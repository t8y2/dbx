import { expect, test } from "vitest";
import { mergeSidebarRegexIndexScopes, qualifiedTableQueryMatchesScope, splitQualifiedTableQuery, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

test("splitQualifiedTableQuery ignores unqualified and malformed queries", () => {
  expect(splitQualifiedTableQuery("orders")).toBeNull();
  expect(splitQualifiedTableQuery("")).toBeNull();
  expect(splitQualifiedTableQuery("orders.")).toBeNull();
  expect(splitQualifiedTableQuery(".orders")).toBeNull();
  expect(splitQualifiedTableQuery("app..orders")).toBeNull();
  expect(splitQualifiedTableQuery("a.b.c.d")).toBeNull();
});

test("splitQualifiedTableQuery reads schema.table and database.schema.table", () => {
  expect(splitQualifiedTableQuery("APP.ORDERS")).toEqual({ schema: "APP", name: "ORDERS" });
  expect(splitQualifiedTableQuery("  app . orders  ")).toEqual({ schema: "app", name: "orders" });
  expect(splitQualifiedTableQuery("sales.public.orders")).toEqual({ database: "sales", schema: "public", name: "orders" });
});

test("qualifiedTableQueryMatchesScope compares schema case-insensitively and honours the database part", () => {
  const qualified = splitQualifiedTableQuery("app.orders")!;
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "APP", schema: "APP" })).toBe(true);
  expect(qualifiedTableQueryMatchesScope(qualified, { schema: "other" })).toBe(false);
  expect(qualifiedTableQueryMatchesScope(qualified, {})).toBe(false);

  const threePart = splitQualifiedTableQuery("sales.public.orders")!;
  expect(qualifiedTableQueryMatchesScope(threePart, { database: "sales", schema: "public" })).toBe(true);
  expect(qualifiedTableQueryMatchesScope(threePart, { database: "warehouse", schema: "public" })).toBe(false);
});

test("a flat engine matches the database when the scope has no schema", () => {
  const qualified = splitQualifiedTableQuery("mydb.orders")!;
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "mydb" })).toBe(true);
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "otherdb" })).toBe(false);
});

test("a catalog engine matches catalog.database.table", () => {
  const qualified = splitQualifiedTableQuery("hive_catalog.sales.orders")!;
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "sales", catalog: "hive_catalog" })).toBe(true);
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "sales", catalog: "other_catalog" })).toBe(false);
});

test("a database name is not treated as a schema on leveled engines", () => {
  const qualified = splitQualifiedTableQuery("sales.orders")!;
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "sales", schema: "dbo" })).toBe(false);
  expect(qualifiedTableQueryMatchesScope(qualified, { database: "sales", schema: "sales" })).toBe(true);
});

function connectionTree(): TreeNode {
  return {
    id: "conn",
    label: "north",
    type: "connection",
    connectionId: "conn",
    isExpanded: true,
    children: [
      {
        id: "conn:APP",
        label: "APP",
        type: "schema",
        connectionId: "conn",
        database: "APP",
        schema: "APP",
        isExpanded: true,
        children: [{ id: "conn:APP:TABLE:INVOICES", label: "INVOICES", type: "table", connectionId: "conn", database: "APP", schema: "APP" }],
      },
    ],
  };
}

function ordersScope(): SidebarRegexIndexScope {
  return {
    parentNodeId: "conn:APP",
    connectionId: "conn",
    database: "APP",
    schema: "APP",
    nodeType: "schema",
    path: [
      { id: "conn", label: "north", type: "connection", connectionId: "conn" },
      { id: "conn:APP", label: "APP", type: "schema", connectionId: "conn", database: "APP", schema: "APP" },
    ],
    entries: [{ name: "ORDERS", table_type: "TABLE", schema: "APP" }],
  };
}

function labels(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.label, ...labels(node.children ?? [])]);
}

test("scopesOnly drops unrelated live nodes so a qualified query cannot leak other tables", () => {
  const merged = mergeSidebarRegexIndexScopes([connectionTree()], [ordersScope()], (node) => node, { scopesOnly: true });
  const mergedLabels = labels(merged);
  expect(mergedLabels).toContain("ORDERS");
  expect(mergedLabels).not.toContain("INVOICES");
});

test("without scopesOnly the live tree is still merged in", () => {
  const merged = mergeSidebarRegexIndexScopes([connectionTree()], [ordersScope()], (node) => node);
  const mergedLabels = labels(merged);
  expect(mergedLabels).toContain("ORDERS");
  expect(mergedLabels).toContain("INVOICES");
});

test("scopesOnly keeps a scope that has no recorded ancestor path", () => {
  const pathless: SidebarRegexIndexScope = { ...ordersScope(), path: undefined };
  const merged = mergeSidebarRegexIndexScopes([connectionTree()], [pathless], (node) => node, { scopesOnly: true });
  expect(labels(merged)).toContain("ORDERS");
});
