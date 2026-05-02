import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildDiagramRelationships,
  filterDiagramTables,
  layoutDiagramTables,
} from "../src/lib/erDiagram.ts";

test("builds relationships only between tables in the diagram", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "orders",
      columns: [],
      foreignKeys: [
        { name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" },
        { name: "orders_external_fk", column: "external_id", ref_table: "external_accounts", ref_column: "id" },
      ],
    },
    {
      name: "users",
      columns: [],
      foreignKeys: [],
    },
  ]);

  assert.deepEqual(relationships, [
    {
      id: "orders:orders_user_id_fk:user_id:users:id",
      name: "orders_user_id_fk",
      sourceTable: "orders",
      sourceColumn: "user_id",
      targetTable: "users",
      targetColumn: "id",
    },
  ]);
});

test("filters diagram tables by table, column, and foreign key names", () => {
  const tables = [
    {
      name: "orders",
      columns: [{ name: "user_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
      foreignKeys: [{ name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
    {
      name: "audit_log",
      columns: [{ name: "payload", data_type: "json", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
      foreignKeys: [],
    },
  ];

  assert.deepEqual(filterDiagramTables(tables, "payload").map((table) => table.name), ["audit_log"]);
  assert.deepEqual(filterDiagramTables(tables, "orders_user").map((table) => table.name), ["orders"]);
  assert.deepEqual(filterDiagramTables(tables, "").map((table) => table.name), ["orders", "audit_log"]);
});

test("lays out diagram tables in stable rows", () => {
  const positions = layoutDiagramTables(
    [
      { name: "users", columns: [] },
      { name: "orders", columns: [] },
      { name: "line_items", columns: [] },
    ],
    { columnsPerRow: 2, cardWidth: 240, rowHeight: 180, gapX: 40, gapY: 30 },
  );

  assert.deepEqual(positions, {
    users: { x: 40, y: 40 },
    orders: { x: 320, y: 40 },
    line_items: { x: 40, y: 250 },
  });
});
