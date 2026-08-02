import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildEngineeringDiagram } from "../../apps/desktop/src/lib/diagram/engineeringDiagram.ts";
import { buildEngineeringDiagramSvg, buildTableDiagramSvg, diagramSvgFileName } from "../../apps/desktop/src/lib/export/diagramSvgExport.ts";
import { buildDiagramRelationships, normalizeCustomDiagramRelationship, type DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";

const tables: DiagramTable[] = [
  {
    name: "users",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name & note", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
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
];

test("exports the table diagram as standalone SVG", () => {
  const relationships = buildDiagramRelationships(tables);
  const svg = buildTableDiagramSvg({
    tables,
    relationships,
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 360, y: 40 },
    },
    relationshipLayouts: {
      [relationships[0].id]: {
        path: "M 360 96 L 310 96",
        routePoints: [
          { x: 360, y: 96 },
          { x: 310, y: 96 },
        ],
        sourceCardinality: { x: 346, y: 86 },
        targetCardinality: { x: 324, y: 86 },
      },
    },
    canvas: { width: 720, height: 320 },
    cardWidth: 270,
    cardHeaderHeight: 44,
    columnRowHeight: 24,
    maxVisibleColumns: 9,
    moreColumnsLabel: (count) => `+ ${count} columns`,
  });

  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M 360 96 L 310 96"/);
  assert.match(svg, /data-cardinality-end="source"[^>]*>N<\/text>/);
  assert.match(svg, /data-cardinality-end="target"[^>]*>1<\/text>/);
  assert.match(svg, /orders\.user_id \(N:1\) -&gt; users\.id/);
  assert.match(svg, />users</);
  assert.match(svg, />orders</);
  assert.match(svg, />name &amp; note</);
  assert.doesNotMatch(svg, /<foreignObject/);
});

test("exports many-to-many cardinalities at both relationship endpoints", () => {
  const customRelationship = {
    ...normalizeCustomDiagramRelationship({
      name: "users_orders",
      sourceTable: "users",
      sourceColumn: "id",
      targetTable: "orders",
      targetColumn: "id",
      sourceCardinality: "N",
      targetCardinality: "N",
    }),
    kind: "custom" as const,
  };
  const svg = buildTableDiagramSvg({
    tables,
    relationships: [customRelationship],
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 360, y: 40 },
    },
    relationshipLayouts: {
      [customRelationship.id]: {
        path: "M 310 96 L 360 96",
        routePoints: [
          { x: 310, y: 96 },
          { x: 360, y: 96 },
        ],
        sourceCardinality: { x: 324, y: 86 },
        targetCardinality: { x: 346, y: 86 },
      },
    },
    canvas: { width: 720, height: 320 },
    cardWidth: 270,
    cardHeaderHeight: 44,
    columnRowHeight: 24,
    maxVisibleColumns: 9,
  });

  assert.match(svg, /data-cardinality-end="source"[^>]*>N<\/text>/);
  assert.match(svg, /data-cardinality-end="target"[^>]*>N<\/text>/);
  assert.match(svg, /users\.id \(N:N\) -&gt; orders\.id/);
});

test("infers one-to-one foreign keys from primary and unique source columns", () => {
  const primaryKeyTables: DiagramTable[] = [
    tables[0],
    {
      ...tables[1],
      columns: tables[1].columns.map((column) => ({ ...column, is_primary_key: column.name === "user_id" })),
    },
  ];
  assert.equal(buildDiagramRelationships(primaryKeyTables)[0].sourceCardinality, "1");

  const uniqueIndexTables: DiagramTable[] = [
    tables[0],
    {
      ...tables[1],
      indexes: [{ name: "orders_user_id_unique", columns: ["user_id"], is_unique: true, is_primary: false }],
    },
  ];
  assert.equal(buildDiagramRelationships(uniqueIndexTables)[0].sourceCardinality, "1");

  const sourceColumnsContainingUniqueKey: DiagramTable[] = [
    tables[0],
    {
      ...tables[1],
      columns: [...tables[1].columns, { name: "tenant_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null }],
      foreignKeys: [...tables[1].foreignKeys, { name: "orders_user_id_fk", column: "tenant_id", ref_table: "users", ref_column: "tenant_id" }],
      indexes: [{ name: "orders_user_id_unique", columns: ["user_id"], is_unique: true, is_primary: false }],
    },
  ];
  assert.equal(buildDiagramRelationships(sourceColumnsContainingUniqueKey)[0].sourceCardinality, "1");

  const partialUniqueIndexTables: DiagramTable[] = [
    tables[0],
    {
      ...tables[1],
      indexes: [{ name: "orders_user_id_active_unique", columns: ["user_id"], is_unique: true, is_primary: false, filter: "deleted_at IS NULL" }],
    },
  ];
  assert.equal(buildDiagramRelationships(partialUniqueIndexTables)[0].sourceCardinality, "N");
});

test("expands the exported viewBox for a relationship routed left of the canvas", () => {
  const relationships = buildDiagramRelationships(tables);
  const svg = buildTableDiagramSvg({
    tables,
    relationships,
    positions: {
      users: { x: 16, y: 40 },
      orders: { x: 336, y: 40 },
    },
    relationshipLayouts: {
      [relationships[0].id]: {
        path: "M 14 96 L -20 96 L -20 120 L 14 120",
        routePoints: [
          { x: 14, y: 96 },
          { x: -20, y: 96 },
          { x: -20, y: 120 },
          { x: 14, y: 120 },
        ],
        sourceCardinality: { x: 0, y: 86 },
        targetCardinality: { x: 0, y: 110 },
      },
    },
    canvas: { width: 720, height: 320 },
    cardWidth: 270,
    cardHeaderHeight: 44,
    columnRowHeight: 24,
    maxVisibleColumns: 9,
  });

  assert.match(svg, /viewBox="-40 0 760 320"/);
  assert.match(svg, /<rect x="-40" y="0" width="760" height="320" fill="#fafafa"/);
  assert.match(svg, /<path d="M 14 96 L -20 96 L -20 120 L 14 120"/);
});

test("exports the engineering ER diagram with Chen-style shapes and cardinalities", () => {
  const relationships = buildDiagramRelationships(tables);
  const diagram = buildEngineeringDiagram(tables, relationships, {
    users: { x: 40, y: 40 },
    orders: { x: 360, y: 40 },
  });
  const svg = buildEngineeringDiagramSvg(diagram);

  assert.match(svg, /^<svg /);
  assert.match(svg, /<ellipse /);
  assert.match(svg, /<polygon /);
  assert.match(svg, /<rect /);
  assert.match(svg, />N</);
  assert.match(svg, />1</);
  assert.match(svg, /text-decoration="underline"/);
  assert.doesNotMatch(svg, /<foreignObject/);
});

test("builds safe SVG file names from the active diagram context", () => {
  assert.equal(diagramSvgFileName("prod/main", "billing db", "engineering"), "dbx-prod-main-billing-db-engineering-er.svg");
  assert.equal(diagramSvgFileName("", "", "table"), "dbx-diagram-table-structure.svg");
});
