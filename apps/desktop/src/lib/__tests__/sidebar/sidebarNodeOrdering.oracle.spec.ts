import { describe, expect, it } from "vitest";
import { orderSidebarConnectionUtilitiesForDisplay, sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import type { TreeNode } from "@/types/database";

describe("Oracle sidebar ordering", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("keeps public objects before pinned schemas at connection and database level (%s)", (engine) => {
    for (const type of ["connection", "database"] as const) {
      const children: TreeNode[] = [
        { id: "default", type: "schema", label: "Z", pinned: true },
        { id: "public", type: "oracle-shared-objects", label: "tree.publicObjects" },
        { id: "a", type: "schema", label: "A" },
      ];
      const sorted = sortSidebarTreeChildrenForParent({ type }, children, engine);
      expect(sorted.map((node) => node.id)).toEqual(["public", "a", "default"]);
      const parent: TreeNode = { id: "parent", type, label: "parent", children };
      const root: TreeNode = type === "database" ? { id: "c", type: "connection", label: "c", children: [parent] } : parent;
      const projected = orderSidebarConnectionUtilitiesForDisplay([root]);
      const result = type === "database" ? projected[0].children![0] : projected[0];
      expect(result.children!.map((node) => node.id)).toEqual(["public", "default", "a"]);
      expect(children.map((node) => node.id)).toEqual(["default", "public", "a"]);
      expect(orderSidebarConnectionUtilitiesForDisplay(projected)).toBe(projected);
    }
  });

  it("orders saved queries, extensions and public objects ahead of a cached pinned schema", () => {
    const children: TreeNode[] = [
      { id: "schema", type: "schema", label: "A", pinned: true },
      { id: "public", type: "oracle-shared-objects", label: "tree.tenantObjects" },
      { id: "ext", type: "connection-extensions", label: "tree.extensions" },
      { id: "sql", type: "saved-sql-root", label: "sql" },
    ];
    const projected = orderSidebarConnectionUtilitiesForDisplay([{ id: "c", type: "connection", label: "c", children }]);
    expect(projected[0].children!.map((node) => node.id)).toEqual(["sql", "ext", "public", "schema"]);
    expect(sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle").map((node) => node.id)).toEqual(["sql", "ext", "public", "schema"]);
  });

  it("keeps extensions ahead of schemas in both ordering paths without moving saved queries", () => {
    const children: TreeNode[] = [
      { id: "z", type: "schema", label: "Z" },
      { id: "ext", type: "connection-extensions", label: "zzz extensions" },
      { id: "a", type: "schema", label: "A" },
      { id: "sql", type: "saved-sql-root", label: "sql" },
    ];
    const sorted = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(sorted.map((node) => node.id)).toEqual(["sql", "ext", "a", "z"]);
    const projected = orderSidebarConnectionUtilitiesForDisplay([{ id: "c", type: "connection", label: "c", children }]);
    expect(projected[0].children!.map((node) => node.id)).toEqual(["sql", "ext", "z", "a"]);
    expect(children.map((node) => node.id)).toEqual(["z", "ext", "a", "sql"]);
  });
  it("projects an already-loaded grouped connection without changing schema order, nested objects, or the live tree", () => {
    const children: TreeNode[] = [
      { id: "links", type: "oracle-db-links", label: "links" },
      { id: "z", type: "schema", label: "Z", children: [{ id: "table", type: "table", label: "table" }] },
      { id: "a", type: "schema", label: "A" },
      { id: "users", type: "user-admin", label: "users" },
      { id: "jobs", type: "database-job-admin", label: "jobs" },
      { id: "sql", type: "saved-sql-root", label: "sql" },
    ];
    const nodes: TreeNode[] = [{ id: "folder", type: "connection-group", label: "folder", children: [{ id: "c1", type: "connection", label: "c1", children }] }];
    const result = orderSidebarConnectionUtilitiesForDisplay(nodes);
    expect(result[0].children![0].children!.map((node) => node.id)).toEqual(["sql", "z", "a", "links", "jobs", "users"]);
    expect(children.map((node) => node.id)).toEqual(["links", "z", "a", "users", "jobs", "sql"]);
    expect(result[0].children![0].children![1]).toBe(children[1]);
    expect(orderSidebarConnectionUtilitiesForDisplay(result)).toBe(result);
  });
  it("keeps schemas sorted before the three connection tools after cache normalization", () => {
    const children: TreeNode[] = [
      { id: "users", type: "user-admin", label: "users" },
      { id: "jobs", type: "database-job-admin", label: "jobs" },
      { id: "z", type: "schema", label: "ZEBRA" },
      { id: "links", type: "oracle-db-links", label: "links" },
      { id: "a", type: "schema", label: "ALPHA" },
    ];
    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(result.map((node) => node.id)).toEqual(["a", "z", "links", "jobs", "users"]);
    expect(sortSidebarTreeChildrenForParent({ type: "connection" }, result, "oracle")).toEqual(result);
  });
  it("sorts schema nodes alphabetically and places database links at the bottom", () => {
    const children: TreeNode[] = [
      { id: "c1:__oracle_db_links", label: "tree.databaseLinks", type: "oracle-db-links", connectionId: "c1" },
      { id: "c1:ZEBRA:ZEBRA", label: "ZEBRA", type: "schema", connectionId: "c1", database: "ZEBRA", schema: "ZEBRA" },
      { id: "c1:ALPHA:ALPHA", label: "ALPHA", type: "schema", connectionId: "c1", database: "ALPHA", schema: "ALPHA" },
    ];

    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(result.map((node) => node.id)).toEqual(["c1:ALPHA:ALPHA", "c1:ZEBRA:ZEBRA", "c1:__oracle_db_links"]);
  });

  it("places saved queries at the top, schemas in the middle, and database links at the bottom", () => {
    const children: TreeNode[] = [
      { id: "c1:__oracle_db_links", label: "tree.databaseLinks", type: "oracle-db-links", connectionId: "c1" },
      { id: "c1:MY_SCHEMA:MY_SCHEMA", label: "MY_SCHEMA", type: "schema", connectionId: "c1", database: "MY_SCHEMA", schema: "MY_SCHEMA" },
      { id: "c1:__queries", label: "tree.queries", type: "saved-sql-root", connectionId: "c1" },
    ];

    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(result.map((node) => node.id)).toEqual(["c1:__queries", "c1:MY_SCHEMA:MY_SCHEMA", "c1:__oracle_db_links"]);
  });
});
