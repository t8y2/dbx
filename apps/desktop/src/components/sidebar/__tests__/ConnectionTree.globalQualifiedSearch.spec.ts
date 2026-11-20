import { computed, ref } from "vue";
import { expect, test } from "vitest";
import { createSidebarLabelMatcher } from "@/lib/sidebar/sidebarSearch";
import { mergeSidebarRegexIndexScopes, qualifiedTableQueryMatchesScope, splitQualifiedTableQuery, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

const compiled = compileConnectionTreeTestScript(["qualifiedGlobalSearch", "globalIndexSearchQuery", "filterGloballyIndexedTables"]);

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
      {
        id: "conn:REPORTING",
        label: "REPORTING",
        type: "schema",
        connectionId: "conn",
        database: "REPORTING",
        schema: "REPORTING",
        isExpanded: true,
        children: [{ id: "conn:REPORTING:TABLE:ORDERS", label: "ORDERS", type: "table", connectionId: "conn", database: "REPORTING", schema: "REPORTING" }],
      },
    ],
  };
}

function scope(schema: string): SidebarRegexIndexScope {
  return {
    parentNodeId: `conn:${schema}`,
    connectionId: "conn",
    database: schema,
    schema,
    nodeType: "schema",
    path: [
      { id: "conn", label: "north", type: "connection", connectionId: "conn" },
      { id: `conn:${schema}`, label: schema, type: "schema", connectionId: "conn", database: schema, schema },
    ],
    entries: [{ name: "ORDERS", table_type: "TABLE", schema }],
  };
}

function labels(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.label, ...labels(node.children ?? [])]);
}

function flatTree(): TreeNode {
  return {
    id: "conn",
    label: "north",
    type: "connection",
    connectionId: "conn",
    isExpanded: true,
    children: [
      {
        id: "conn:mydb",
        label: "mydb",
        type: "database",
        connectionId: "conn",
        database: "mydb",
        isExpanded: true,
        children: [{ id: "conn:mydb:TABLE:ORDERS", label: "ORDERS", type: "table", connectionId: "conn", database: "mydb" }],
      },
    ],
  };
}

function flatScope(): SidebarRegexIndexScope {
  return {
    parentNodeId: "conn:mydb",
    connectionId: "conn",
    database: "mydb",
    nodeType: "database",
    path: [
      { id: "conn", label: "north", type: "connection", connectionId: "conn" },
      { id: "conn:mydb", label: "mydb", type: "database", connectionId: "conn", database: "mydb" },
    ],
    entries: [{ name: "ORDERS", table_type: "TABLE" }],
  };
}

function fixture(query: string, scopes: SidebarRegexIndexScope[] = [scope("APP"), scope("REPORTING")]) {
  const deferredSearchQuery = ref(query);
  const searchMatchMode = ref<"fuzzy" | "contains" | "edges" | "exact">("fuzzy");
  const globalTableSearchScopes = ref<SidebarRegexIndexScope[]>(scopes);
  const bindings = {
    computed,
    deferredSearchQuery,
    regexMode: ref(false),
    searchMatchMode,
    globalTableSearchScopes,
    store: { resolveSidebarSearchDetailTable: (node: TreeNode) => node },
    createSidebarLabelMatcher,
    mergeSidebarRegexIndexScopes,
    splitQualifiedTableQuery,
    qualifiedTableQueryMatchesScope,
  };
  const api = new Function(...Object.keys(bindings), `${compiled}; return { qualifiedGlobalSearch, globalIndexSearchQuery, filterGloballyIndexedTables };`)(...Object.values(bindings)) as {
    qualifiedGlobalSearch: { value: { schema: string; name: string } | null };
    globalIndexSearchQuery: { value: string };
    filterGloballyIndexedTables: (nodes: TreeNode[]) => TreeNode[];
  };
  return { ...api, deferredSearchQuery, globalTableSearchScopes };
}

test("a qualified query keeps only the named schema", () => {
  const view = fixture("app.orders");
  expect(view.qualifiedGlobalSearch.value).toEqual({ schema: "app", name: "orders" });
  expect(view.globalIndexSearchQuery.value).toBe("orders");

  const result = view.filterGloballyIndexedTables([connectionTree()]);
  const resultLabels = labels(result);
  expect(resultLabels).toContain("ORDERS");
  expect(resultLabels).not.toContain("INVOICES");
  expect(resultLabels).toContain("APP");
  expect(resultLabels).not.toContain("REPORTING");
});

test("a qualified query with a mismatched schema yields nothing", () => {
  const view = fixture("warehouse.orders");
  const result = view.filterGloballyIndexedTables([connectionTree()]);
  expect(labels(result)).not.toContain("ORDERS");
});

test("an unqualified query still searches every schema", () => {
  const view = fixture("orders");
  expect(view.qualifiedGlobalSearch.value).toBeNull();
  expect(view.globalIndexSearchQuery.value).toBe("orders");

  const result = view.filterGloballyIndexedTables([connectionTree()]);
  const resultLabels = labels(result);
  expect(resultLabels).toContain("ORDERS");
  expect(resultLabels).toContain("INVOICES");
});

test("a flat engine resolves database.table through the database node", () => {
  const view = fixture("mydb.orders", [flatScope()]);
  const result = view.filterGloballyIndexedTables([flatTree()]);
  expect(labels(result)).toContain("ORDERS");
});
