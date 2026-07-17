import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildDiagramJoinSql, buildDiagramRelationships, filterDiagramTables, layoutDiagramTables, normalizeCustomDiagramRelationship } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";

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
      kind: "foreign-key",
      sourceTable: "orders",
      sourceColumn: "user_id",
      targetTable: "users",
      targetColumn: "id",
      sourceCardinality: "N",
      targetCardinality: "1",
    },
  ]);
});

test("merges valid custom relationships with foreign key relationships", () => {
  const relationship = normalizeCustomDiagramRelationship({
    name: "users_audit",
    sourceTable: "users",
    sourceColumn: "email",
    targetTable: "audit_log",
    targetColumn: "actor_email",
    sourceCardinality: "1",
    targetCardinality: "N",
  });

  const relationships = buildDiagramRelationships(
    [
      {
        name: "users",
        columns: [{ name: "email", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
        foreignKeys: [],
      },
      {
        name: "audit_log",
        columns: [{ name: "actor_email", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
        foreignKeys: [],
      },
    ],
    [relationship],
  );

  assert.deepEqual(relationships, [
    {
      ...relationship,
      kind: "custom",
    },
  ]);
});

test("ignores custom relationships with missing tables or columns", () => {
  const relationships = buildDiagramRelationships(
    [
      {
        name: "users",
        columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        foreignKeys: [],
      },
    ],
    [
      normalizeCustomDiagramRelationship({
        name: "missing_table",
        sourceTable: "users",
        sourceColumn: "id",
        targetTable: "orders",
        targetColumn: "user_id",
        sourceCardinality: "1",
        targetCardinality: "N",
      }),
      normalizeCustomDiagramRelationship({
        name: "missing_column",
        sourceTable: "users",
        sourceColumn: "email",
        targetTable: "users",
        targetColumn: "id",
        sourceCardinality: "1",
        targetCardinality: "1",
      }),
    ],
  );

  assert.deepEqual(relationships, []);
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

  assert.deepEqual(
    filterDiagramTables(tables, "payload").map((table) => table.name),
    ["audit_log"],
  );
  assert.deepEqual(
    filterDiagramTables(tables, "orders_user").map((table) => table.name),
    ["orders"],
  );
  assert.deepEqual(
    filterDiagramTables(tables, "").map((table) => table.name),
    ["orders", "audit_log"],
  );
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

test("generates join SQL from diagram relationships", () => {
  const relationships = buildDiagramRelationships(
    [
      {
        name: "users",
        columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        foreignKeys: [],
      },
      {
        name: "orders",
        columns: [{ name: "user_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
        foreignKeys: [{ name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
      },
    ],
    [],
  );

  assert.equal(
    buildDiagramJoinSql(relationships),
    `SELECT
  t1.*,
  t2.*
FROM orders t1
LEFT JOIN users t2 ON t1.user_id = t2.id`,
  );
});

test("combines multiple relationship conditions between joined tables", () => {
  const relationships = [
    normalizeCustomDiagramRelationship({
      name: "orders_customer_id",
      sourceTable: "orders",
      sourceColumn: "customer_id",
      targetTable: "customers",
      targetColumn: "id",
      sourceCardinality: "N",
      targetCardinality: "1",
    }),
    normalizeCustomDiagramRelationship({
      name: "orders_customer_region",
      sourceTable: "orders",
      sourceColumn: "customer_region",
      targetTable: "customers",
      targetColumn: "region",
      sourceCardinality: "N",
      targetCardinality: "1",
    }),
  ].map((relationship) => ({ ...relationship, kind: "custom" as const }));

  assert.equal(
    buildDiagramJoinSql(relationships),
    `SELECT
  t1.*,
  t2.*
FROM orders t1
LEFT JOIN customers t2 ON t1.customer_id = t2.id AND t1.customer_region = t2.region`,
  );
});
