import { test } from "vitest";
import assert from "node:assert/strict";
import { buildSqlServerDatabaseTreeNodes } from "../../apps/desktop/src/lib/sqlServerTree.ts";
import type { ObjectInfo } from "../../apps/desktop/src/types/database.ts";

function obj(name: string, objectType = "TABLE"): ObjectInfo {
  return {
    name,
    object_type: objectType,
  };
}

test("SQL Server database tree groups dbo objects and keeps non-default schemas", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo", "zeta", "sales"], [obj("customers"), obj("customer_view", "VIEW"), obj("get_total", "FUNCTION")]);

  const topLevel = nodes.map((n) => ({ id: n.id, label: n.label, type: n.type }));
  assert.deepEqual(topLevel, [
    { id: "conn:app:__tables", label: "tree.tables", type: "group-tables" },
    { id: "conn:app:__views", label: "tree.views", type: "group-views" },
    { id: "conn:app:__functions", label: "tree.functions", type: "group-functions" },
    { id: "conn:app:sales", label: "sales", type: "schema" },
    { id: "conn:app:zeta", label: "zeta", type: "schema" },
  ]);

  const tableGroup = nodes.find((n) => n.type === "group-tables");
  assert.deepEqual(
    tableGroup?.children?.map((c) => c.label),
    ["customers"],
  );

  const functionGroup = nodes.find((n) => n.type === "group-functions");
  assert.deepEqual(
    functionGroup?.children?.map((c) => c.label),
    ["get_total"],
  );
});

test("SQL Server database tree shows only schemas when dbo has no objects", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo", "archive", "beta"], []);

  assert.deepEqual(
    nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    [
      { id: "conn:app:archive", label: "archive", type: "schema" },
      { id: "conn:app:beta", label: "beta", type: "schema" },
    ],
  );
});

test("SQL Server database tree groups procedures alongside tables", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo"], [obj("orders"), obj("sp_refresh", "PROCEDURE")]);

  assert.deepEqual(
    nodes.map((n) => ({ label: n.label, type: n.type })),
    [
      { label: "tree.tables", type: "group-tables" },
      { label: "tree.procedures", type: "group-procedures" },
    ],
  );
});

test("SQL Server database tree can render lazy object groups before metadata is loaded", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo", "sales"], [], {
    lazyObjectTypes: ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"],
  });

  assert.deepEqual(
    nodes.map((n) => ({ label: n.label, type: n.type, count: n.objectCount, children: n.children })),
    [
      { label: "tree.tables", type: "group-tables", count: undefined, children: [] },
      { label: "tree.views", type: "group-views", count: undefined, children: [] },
      { label: "tree.procedures", type: "group-procedures", count: undefined, children: [] },
      { label: "tree.functions", type: "group-functions", count: undefined, children: [] },
      {
        label: "sales",
        type: "schema",
        count: undefined,
        children: [],
      },
    ],
  );
});
