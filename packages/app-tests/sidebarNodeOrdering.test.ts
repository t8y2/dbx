import assert from "node:assert/strict";
import { test } from "vitest";
import { sortSidebarTreeChildrenForParent } from "../../apps/desktop/src/lib/sidebar/sidebarNodeOrdering.ts";
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

test("keeps MongoDB GridFS entry before collections", () => {
  const parent: Pick<TreeNode, "type"> = { type: "mongo-db" };
  const children: TreeNode[] = [
    { id: "c:db:movies", label: "movies", type: "mongo-collection" },
    { id: "c:db:__gridfs", label: "GridFS", type: "mongo-gridfs" as TreeNode["type"] },
    { id: "c:db:comments", label: "comments", type: "mongo-collection" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, children, "mongodb");

  assert.deepEqual(
    sorted.map((child) => [child.type, child.label]),
    [
      ["mongo-gridfs", "GridFS"],
      ["mongo-collection", "comments"],
      ["mongo-collection", "movies"],
    ],
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

test("keeps connection utility nodes in fixed positions", () => {
  const parent: Pick<TreeNode, "type"> = { type: "connection" };
  const children: TreeNode[] = [
    { id: "conn:__user_admin", label: "tree.userAdmin", type: "user-admin" },
    { id: "conn:z", label: "z", type: "database" },
    { id: "conn:__saved_sql", label: "tree.savedSql", type: "saved-sql-root" },
    { id: "conn:a", label: "a", type: "database" },
  ];

  const sorted = sortSidebarTreeChildrenForParent(parent, children, "postgres");

  assert.deepEqual(
    sorted.map((child) => [child.type, child.label]),
    [
      ["saved-sql-root", "tree.savedSql"],
      ["database", "a"],
      ["database", "z"],
      ["user-admin", "tree.userAdmin"],
    ],
  );
});
