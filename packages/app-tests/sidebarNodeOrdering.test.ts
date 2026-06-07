import assert from "node:assert/strict";
import test from "node:test";
import { sortSidebarTreeChildrenForParent } from "../../apps/desktop/src/lib/sidebarNodeOrdering.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("reorders cached MongoDB collections alphabetically", () => {
  const parent: Pick<TreeNode, "type"> = { type: "mongo-db" };
  const children: TreeNode[] = [
    { id: "c:db:comments", label: "comments", type: "mongo-collection" },
    { id: "c:db:movies", label: "movies", type: "mongo-collection" },
    { id: "c:db:sessions", label: "sessions", type: "mongo-collection" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, [children[2], children[0], children[1]], "mongodb");

  assert.deepEqual(
    sorted.map((child) => child.label),
    ["comments", "movies", "sessions"],
  );
});

test("keeps SQL Server object groups first and sorts schema children after them", () => {
  const parent: Pick<TreeNode, "type"> = { type: "database" };
  const children: TreeNode[] = [
    { id: "conn:app:zeta", label: "zeta", type: "schema" },
    { id: "conn:app:__tables", label: "tree.tables", type: "group-tables" },
    { id: "conn:app:archive", label: "archive", type: "schema" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, children, "sqlserver");

  assert.deepEqual(
    sorted.map((child) => [child.type, child.label]),
    [
      ["group-tables", "tree.tables"],
      ["schema", "archive"],
      ["schema", "zeta"],
    ],
  );
});

test("keeps DuckDB schemas before attached catalogs while sorting both", () => {
  const parent: Pick<TreeNode, "type"> = { type: "connection" };
  const children: TreeNode[] = [
    { id: "conn:analytics_20", label: "analytics_20", type: "database" },
    { id: "conn:main:mysql", label: "mysql", type: "schema" },
    { id: "conn:analytics_3", label: "analytics_3", type: "database" },
    { id: "conn:main:main", label: "main", type: "schema" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, children, "duckdb");

  assert.deepEqual(
    sorted.map((child) => [child.type, child.label]),
    [
      ["schema", "main"],
      ["schema", "mysql"],
      ["database", "analytics_3"],
      ["database", "analytics_20"],
    ],
  );
});
