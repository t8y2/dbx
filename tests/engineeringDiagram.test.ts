import { strict as assert } from "node:assert";
import test from "node:test";
import { buildEngineeringDiagram } from "../src/lib/engineeringDiagram.ts";
import type { DiagramRelationship, DiagramTable } from "../src/lib/erDiagram.ts";

const tables: DiagramTable[] = [
  {
    name: "orders",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
      { name: "status", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [
      { name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" },
    ],
  },
  {
    name: "users",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
  },
];

const relationships: DiagramRelationship[] = [
  {
    id: "orders:orders_user_id_fk:user_id:users:id",
    name: "orders_user_id_fk",
    sourceTable: "orders",
    sourceColumn: "user_id",
    targetTable: "users",
    targetColumn: "id",
  },
];

test("builds engineering ER nodes from tables, columns, and relationships", () => {
  const diagram = buildEngineeringDiagram(tables, relationships, {
    orders: { x: 300, y: 200 },
    users: { x: 40, y: 200 },
  });

  assert.deepEqual(diagram.entities.map((entity) => entity.name), ["orders", "users"]);
  assert.equal(diagram.attributes.filter((attr) => attr.tableName === "orders").length, 3);
  assert.equal(diagram.relationships[0]?.sourceCardinality, "N");
  assert.equal(diagram.relationships[0]?.targetCardinality, "1");
});

test("sizes the engineering canvas around attributes and relationship diamonds", () => {
  const diagram = buildEngineeringDiagram(tables, relationships, {
    orders: { x: 300, y: 200 },
    users: { x: 40, y: 200 },
  });

  assert.ok(diagram.canvas.width > 500);
  assert.ok(diagram.canvas.height > 300);
});

test("keeps dense attribute clouds from overlapping", () => {
  const denseTables: DiagramTable[] = [{
    name: "roles",
    columns: Array.from({ length: 36 }, (_, index) => ({
      name: `column_${index + 1}`,
      data_type: "varchar",
      is_nullable: true,
      column_default: null,
      is_primary_key: index === 0,
      extra: null,
    })),
    foreignKeys: [],
  }];

  const diagram = buildEngineeringDiagram(denseTables, [], {
    roles: { x: 40, y: 40 },
  });
  const rects = [
    ...diagram.entities,
    ...diagram.attributes,
  ];

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const left = rects[i];
      const right = rects[j];
      const overlaps = left.x < right.x + right.width &&
        left.x + left.width > right.x &&
        left.y < right.y + right.height &&
        left.y + left.height > right.y;
      assert.equal(overlaps, false, `${left.id} overlaps ${right.id}`);
    }
  }
});

test("keeps adjacent entity centers reasonably close", () => {
  const diagram = buildEngineeringDiagram(tables, relationships, {
    users: { x: 40, y: 40 },
    orders: { x: 360, y: 40 },
  });
  const users = diagram.entities.find((entity) => entity.name === "users")!;
  const orders = diagram.entities.find((entity) => entity.name === "orders")!;
  const userCenter = users.x + users.width / 2;
  const orderCenter = orders.x + orders.width / 2;

  assert.ok(Math.abs(orderCenter - userCenter) <= 560);
});
