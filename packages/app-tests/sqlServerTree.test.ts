import { test } from "vitest";
import assert from "node:assert/strict";
import { buildSqlServerDatabaseTreeNodes } from "../../apps/desktop/src/lib/sqlServerTree.ts";

test("SQL Server database tree shows schemas before objects", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo", "zeta", "sales"]);

  const topLevel = nodes.map((n) => ({ id: n.id, label: n.label, type: n.type }));
  assert.deepEqual(topLevel, [
    { id: "conn:app:dbo", label: "dbo", type: "schema" },
    { id: "conn:app:sales", label: "sales", type: "schema" },
    { id: "conn:app:zeta", label: "zeta", type: "schema" },
  ]);
});

test("SQL Server database tree keeps dbo when no other schemas exist", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo"]);

  assert.deepEqual(
    nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    [{ id: "conn:app:dbo", label: "dbo", type: "schema" }],
  );
});

test("SQL Server database tree includes cdc schema", () => {
  const nodes = buildSqlServerDatabaseTreeNodes("conn", "app", ["dbo", "cdc"]);

  assert.deepEqual(
    nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    [
      { id: "conn:app:cdc", label: "cdc", type: "schema" },
      { id: "conn:app:dbo", label: "dbo", type: "schema" },
    ],
  );
});
