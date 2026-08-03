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

test("R1: single-column unique FK is 1:1", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "users",
      columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [],
    },
    {
      name: "user_profiles",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      ],
      foreignKeys: [{ name: "user_profiles_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
      indexes: [{ name: "user_profiles_user_id_uq", columns: ["user_id"], is_unique: true, is_primary: false }],
    },
  ]);
  assert.equal(relationships[0].sourceCardinality, "1");
  assert.equal(relationships[0].targetCardinality, "1");
});

test("R2: composite unique covering composite FK is 1:1", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "tenants",
      columns: [
        { name: "org_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      ],
      foreignKeys: [],
    },
    {
      name: "memberships",
      columns: [
        { name: "org_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
        { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      ],
      foreignKeys: [
        { name: "memberships_tenant_fk", column: "org_id", ref_table: "tenants", ref_column: "org_id" },
        { name: "memberships_tenant_fk", column: "user_id", ref_table: "tenants", ref_column: "id" },
      ],
      indexes: [{ name: "memberships_uq", columns: ["user_id", "org_id"], is_unique: true, is_primary: false }],
    },
  ]);
  assert.ok(relationships.every((r) => r.sourceCardinality === "1" && r.targetCardinality === "1"));
});

test("R3: ordinary FK remains N:1", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "users",
      columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [],
    },
    {
      name: "orders",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      ],
      foreignKeys: [{ name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
  ]);
  assert.equal(relationships[0].sourceCardinality, "N");
  assert.equal(relationships[0].targetCardinality, "1");
});

test("E1: column.is_unique alone yields 1:1 without indexes", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "users",
      columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [],
    },
    {
      name: "profiles",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, is_unique: true, extra: null },
      ],
      foreignKeys: [{ name: "profiles_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
  ]);
  assert.equal(relationships[0].sourceCardinality, "1");
});

test("E2: unique index superset of FK columns stays N:1", () => {
  const relationships = buildDiagramRelationships([
    {
      name: "users",
      columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [],
    },
    {
      name: "orders",
      columns: [
        { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
        { name: "tenant_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      ],
      foreignKeys: [{ name: "orders_user_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
      indexes: [{ name: "orders_uq", columns: ["user_id", "tenant_id"], is_unique: true, is_primary: false }],
    },
  ]);
  assert.equal(relationships[0].sourceCardinality, "N");
});

test("E4/E5: partial unique and markedForDrop unique indexes do not force 1:1", () => {
  const partial = buildDiagramRelationships([
    { name: "users", columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }], foreignKeys: [] },
    {
      name: "orders",
      columns: [{ name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
      foreignKeys: [{ name: "orders_user_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
      indexes: [{ name: "orders_uq", columns: ["user_id"], is_unique: true, is_primary: false, filter: "deleted_at IS NULL" }],
    },
  ]);
  assert.equal(partial[0].sourceCardinality, "N");

  const dropped = buildDiagramRelationships([
    { name: "users", columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }], foreignKeys: [] },
    {
      name: "orders",
      columns: [{ name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
      foreignKeys: [{ name: "orders_user_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
      indexes: [
        {
          id: "idx-1",
          name: "orders_uq",
          columns: ["user_id"],
          isUnique: true,
          isPrimary: false,
          filter: "",
          indexType: "",
          includedColumns: [],
          comment: "",
          markedForDrop: true,
        },
      ],
    },
  ]);
  assert.equal(dropped[0].sourceCardinality, "N");
});

test("E6: PK column set equal to FK columns is 1:1", () => {
  const relationships = buildDiagramRelationships([
    { name: "users", columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }], foreignKeys: [] },
    {
      name: "profiles",
      columns: [{ name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [{ name: "profiles_pk_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
  ]);
  assert.equal(relationships[0].sourceCardinality, "1");
});

test("E7: custom relationship cardinalities are preserved", () => {
  const custom = normalizeCustomDiagramRelationship({
    name: "custom_nn",
    sourceTable: "users",
    sourceColumn: "id",
    targetTable: "orders",
    targetColumn: "id",
    sourceCardinality: "N",
    targetCardinality: "N",
  });
  const relationships = buildDiagramRelationships(
    [
      {
        name: "users",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        foreignKeys: [],
      },
      {
        name: "orders",
        columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        foreignKeys: [],
      },
    ],
    [custom],
  );
  assert.equal(relationships[0].sourceCardinality, "N");
  assert.equal(relationships[0].targetCardinality, "N");
});
