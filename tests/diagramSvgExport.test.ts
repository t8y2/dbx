import { strict as assert } from "node:assert";
import test from "node:test";
import { buildEngineeringDiagram } from "../src/lib/engineeringDiagram.ts";
import {
  buildEngineeringDiagramSvg,
  buildTableDiagramSvg,
  diagramSvgFileName,
} from "../src/lib/diagramSvgExport.ts";
import { buildDiagramRelationships, type DiagramTable } from "../src/lib/erDiagram.ts";

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
    foreignKeys: [
      { name: "orders_user_id_fk", column: "user_id", ref_table: "users", ref_column: "id" },
    ],
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
    relationshipPaths: {
      [relationships[0].id]: "M 360 96 L 310 96",
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
  assert.match(svg, />users</);
  assert.match(svg, />orders</);
  assert.match(svg, />name &amp; note</);
  assert.doesNotMatch(svg, /<foreignObject/);
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
  assert.equal(
    diagramSvgFileName("prod/main", "billing db", "engineering"),
    "dbx-prod-main-billing-db-engineering-er.svg",
  );
  assert.equal(
    diagramSvgFileName("", "", "table"),
    "dbx-diagram-table-structure.svg",
  );
});
