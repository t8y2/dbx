import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildEngineeringDiagram } from "../../apps/desktop/src/lib/diagram/engineeringDiagram.ts";
import { buildEngineeringDiagramSvg, buildTableDiagramSvg, buildTableRelationshipPaths, computeTableDiagramCanvas, diagramSvgFileName } from "../../apps/desktop/src/lib/export/diagramSvgExport.ts";
import { buildDiagramRelationships, normalizeCustomDiagramRelationship, type DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import { pointsToSvgPath } from "../../apps/desktop/src/lib/diagram/edge-obstacle-router.ts";
import { CARD_BOTTOM_PADDING, CARD_HEADER_HEIGHT, CARD_WIDTH, COLUMN_ROW_HEIGHT, COMMENT_LINE_HEIGHT, MARGIN, diagramTableCardHeight } from "../../apps/desktop/src/lib/diagram/diagram-constants.ts";

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
  const polyline = [
    { x: 360, y: 96 },
    { x: 310, y: 96 },
  ];
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
    relationshipPolylines: {
      [relationships[0].id]: polyline,
    },
    canvas: { width: 720, height: 320 },
    cardWidth: 270,
    cardHeaderHeight: 44,
    columnRowHeight: 24,
  });

  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M 360 96 L 310 96"/);
  assert.match(svg, />users</);
  assert.match(svg, />orders</);
  assert.match(svg, />name &amp; note</);
  assert.match(svg, />PK</);
  assert.match(svg, />FK</);
  // Endpoint cardinality badges (FK defaults to N:1 — N near source, 1 near target)
  assert.match(svg, /diagram-cardinality/);
  assert.match(svg, />N</);
  assert.match(svg, />1</);
  assert.doesNotMatch(svg, /<foreignObject/);
});

test("omits relationship paths when relationshipPaths entry is missing", () => {
  const relationships = buildDiagramRelationships(tables);
  const svg = buildTableDiagramSvg({
    tables,
    relationships,
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 360, y: 40 },
    },
    relationshipPaths: {},
    canvas: { width: 720, height: 320 },
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });

  assert.doesNotMatch(svg, /marker-end=/);
  assert.doesNotMatch(svg, /id="dbx-diagram-arrow"/);
});

test("draws visible layers and skips zero-size layers", () => {
  const svg = buildTableDiagramSvg({
    tables: [tables[0]],
    relationships: [],
    positions: { users: { x: 40, y: 40 } },
    relationshipPaths: {},
    canvas: { width: 800, height: 600 },
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    layers: [
      { id: "l1", name: "Core", color: "#3b82f6", x: 10, y: 10, width: 400, height: 200 },
      { id: "l0", name: "Empty", color: "#ef4444", x: 0, y: 0, width: 0, height: 0 },
    ],
  });

  assert.match(svg, /class="diagram-layers"/);
  assert.match(svg, />Core</);
  assert.doesNotMatch(svg, />Empty</);
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
  const polyline = [
    { x: 310, y: 96 },
    { x: 360, y: 96 },
  ];
  const svg = buildTableDiagramSvg({
    tables,
    relationships: [customRelationship],
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 360, y: 40 },
    },
    relationshipPaths: {
      [customRelationship.id]: "M 310 96 L 360 96",
    },
    relationshipPolylines: {
      [customRelationship.id]: polyline,
    },
    canvas: { width: 720, height: 320 },
    cardWidth: 270,
    cardHeaderHeight: 44,
    columnRowHeight: 24,
  });

  assert.match(svg, /diagram-cardinality/);
  const cardinalityTexts = [...svg.matchAll(/diagram-cardinality[\s\S]*?<\/g>/g)].join("");
  assert.match(svg, />N</);
  assert.ok((svg.match(/>N</g) || []).length >= 2, `expected two N badges, got: ${cardinalityTexts.slice(0, 200)}`);
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

test("buildTableRelationshipPaths uses waypoints when length >= 2", () => {
  const relationships = buildDiagramRelationships(tables);
  const waypoints = [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
  ];
  const paths = buildTableRelationshipPaths({
    relationships,
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 400, y: 40 },
    },
    tables,
    waypoints: { [relationships[0].id]: waypoints },
  });

  assert.equal(paths[relationships[0].id], pointsToSvgPath(waypoints));
});

test("buildTableRelationshipPaths falls back to orthogonal path when waypoints are insufficient", () => {
  const relationships = buildDiagramRelationships(tables);
  const paths = buildTableRelationshipPaths({
    relationships,
    positions: {
      users: { x: 40, y: 40 },
      orders: { x: 400, y: 40 },
    },
    tables,
    waypoints: { [relationships[0].id]: [{ x: 0, y: 0 }] },
  });

  assert.ok(paths[relationships[0].id]);
  assert.match(paths[relationships[0].id], /^M/);
  assert.notEqual(paths[relationships[0].id], pointsToSvgPath([{ x: 0, y: 0 }]));
});

test("buildTableRelationshipPaths skips relationships with missing positions", () => {
  const relationships = buildDiagramRelationships(tables);
  const paths = buildTableRelationshipPaths({
    relationships,
    positions: { users: { x: 40, y: 40 } },
    tables,
  });

  assert.equal(paths[relationships[0].id], undefined);
});

test("computeTableDiagramCanvas uses default floor and MARGIN padding", () => {
  const canvas = computeTableDiagramCanvas(
    [],
    {},
    {
      cardWidth: CARD_WIDTH,
      cardHeaderHeight: CARD_HEADER_HEIGHT,
      columnRowHeight: COLUMN_ROW_HEIGHT,
    },
  );

  assert.deepEqual(canvas, { width: 400 + MARGIN, height: 300 + MARGIN, originX: 0, originY: 0 });
});

test("computeTableDiagramCanvas expands for tables and ignores zero-size layers", () => {
  const withTable = computeTableDiagramCanvas(
    [tables[0]],
    { users: { x: 1000, y: 800 } },
    {
      cardWidth: CARD_WIDTH,
      cardHeaderHeight: CARD_HEADER_HEIGHT,
      columnRowHeight: COLUMN_ROW_HEIGHT,
      layers: [{ id: "z", name: "z", color: "#000", x: 0, y: 0, width: 0, height: 0 }],
    },
  );
  const tableHeight = CARD_HEADER_HEIGHT + tables[0].columns.length * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING;
  assert.equal(withTable.originX, 1000 - MARGIN);
  assert.equal(withTable.originY, 800 - MARGIN);
  assert.equal(withTable.width, CARD_WIDTH + 2 * MARGIN);
  assert.equal(withTable.height, tableHeight + 2 * MARGIN);

  const withLayer = computeTableDiagramCanvas(
    [],
    {},
    {
      cardWidth: CARD_WIDTH,
      cardHeaderHeight: CARD_HEADER_HEIGHT,
      columnRowHeight: COLUMN_ROW_HEIGHT,
      layers: [{ id: "big", name: "big", color: "#000", x: 0, y: 0, width: 2000, height: 1500 }],
    },
  );
  assert.equal(withLayer.originX, -MARGIN);
  assert.equal(withLayer.originY, -MARGIN);
  assert.equal(withLayer.width, 2000 + 2 * MARGIN);
  assert.equal(withLayer.height, 1500 + 2 * MARGIN);
});

test("computeTableDiagramCanvas expands for relationship polylines beyond table bounds", () => {
  const canvas = computeTableDiagramCanvas(
    [tables[0]],
    { users: { x: 40, y: 40 } },
    {
      cardWidth: CARD_WIDTH,
      cardHeaderHeight: CARD_HEADER_HEIGHT,
      columnRowHeight: COLUMN_ROW_HEIGHT,
      relationshipPolylines: {
        edge1: [
          { x: 40, y: 40 },
          { x: 40, y: 500 },
        ],
      },
    },
  );
  assert.ok(canvas.originY <= 40 - MARGIN);
  assert.ok(canvas.originY + canvas.height >= 500 + MARGIN);
  assert.ok(canvas.height >= 500 - 40 + 2 * MARGIN);
});

test("buildTableDiagramSvg normalizes far-from-origin content to viewBox 0 0", () => {
  const table = tables[0];
  const positions = { users: { x: 1000, y: 800 } };
  const canvas = computeTableDiagramCanvas([table], positions, {
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  assert.ok((canvas.originX ?? 0) > 0);
  assert.ok((canvas.originY ?? 0) > 0);

  const svg = buildTableDiagramSvg({
    tables: [table],
    relationships: [],
    positions,
    relationshipPaths: {},
    canvas,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  assert.match(svg, new RegExp(`viewBox="0 0 ${canvas.width} ${canvas.height}"`));
  assert.match(svg, /rect x="0" y="0"/);
  assert.match(svg, new RegExp(`transform="translate\\(${-(canvas.originX ?? 0)} ${-(canvas.originY ?? 0)}\\)"`));
  assert.match(svg, /users/);
});

test("buildTableDiagramSvg normalizes negative-origin content to viewBox 0 0", () => {
  const table = tables[0];
  const positions = { users: { x: -200, y: -100 } };
  const canvas = computeTableDiagramCanvas([table], positions, {
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  assert.ok((canvas.originX ?? 0) < 0);
  assert.ok((canvas.originY ?? 0) < 0);

  const svg = buildTableDiagramSvg({
    tables: [table],
    relationships: [],
    positions,
    relationshipPaths: {},
    canvas,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  assert.match(svg, new RegExp(`viewBox="0 0 ${canvas.width} ${canvas.height}"`));
  assert.match(svg, /rect x="0" y="0"/);
  assert.match(svg, new RegExp(`transform="translate\\(${-(canvas.originX ?? 0)} ${-(canvas.originY ?? 0)}\\)"`));
  assert.match(svg, /users/);
});

// Regression for #9445: in multi-schema mode positions are keyed by the schema-qualified
// diagram id, while the exporter used to look them up by the bare table name. Every card then
// fell back to { x: 0, y: 0 } and the exported PNG showed all tables stacked on the origin.
const multiSchemaTables: DiagramTable[] = [
  {
    name: "aaa",
    schema: "sales",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "name", data_type: "varchar(255)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      { name: "sex", data_type: "varchar(255)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      { name: "desc1", data_type: "varchar(255)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
  },
  {
    name: "bbb",
    schema: "ops",
    columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
    foreignKeys: [],
  },
];

const multiSchemaPositions = { "sales.aaa": { x: 40, y: 40 }, "ops.bbb": { x: 480, y: 40 } };

test("multi-schema export positions cards by the schema-qualified diagram key", () => {
  const exportTables = multiSchemaTables.map((table) => ({ ...table, diagramKey: `${table.schema}.${table.name}` }));
  const canvas = computeTableDiagramCanvas(exportTables, multiSchemaPositions, {
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    cardBottomPadding: CARD_BOTTOM_PADDING,
  });
  // Both cards sit on one row: 40 .. 840 plus MARGIN padding on each side.
  assert.equal(canvas.width, 480 + CARD_WIDTH + 2 * MARGIN - 40);
  assert.equal(canvas.originX, 0);
  assert.equal(canvas.height, 40 + (CARD_HEADER_HEIGHT + 4 * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING) + MARGIN);

  const svg = buildTableDiagramSvg({
    tables: exportTables,
    relationships: [],
    positions: multiSchemaPositions,
    relationshipPaths: {},
    canvas,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    cardBottomPadding: CARD_BOTTOM_PADDING,
  });

  assert.match(svg, /<g transform="translate\(40 40\)">/);
  assert.match(svg, /<g transform="translate\(480 40\)">/);
  // Cards must not collapse onto the origin, and the schema badge must survive the export.
  assert.doesNotMatch(svg, /<g transform="translate\(0 0\)"><rect width="360"/);
  assert.match(svg, />sales</);
  assert.match(svg, />ops</);
});

test("multi-schema relationship routing measures card heights by diagram key", () => {
  const exportTables = multiSchemaTables.map((table) => ({ ...table, diagramKey: `${table.schema}.${table.name}` }));
  const relationships = [
    {
      id: "fk:aaa:bbb",
      name: "aaa_bbb_fk",
      sourceTable: "sales.aaa",
      sourceColumn: "id",
      targetTable: "ops.bbb",
      targetColumn: "id",
    },
  ] as unknown as Parameters<typeof buildTableRelationshipPaths>[0]["relationships"];

  const paths = buildTableRelationshipPaths({
    tables: exportTables,
    relationships,
    positions: multiSchemaPositions,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
    cardBottomPadding: CARD_BOTTOM_PADDING,
  });

  const path = paths[relationships[0].id];
  assert.ok(path, "relationship path should be routed");
  // The route must follow the source card's real vertical centre, not the 0-column height.
  const sourceCenter = 40 + (CARD_HEADER_HEIGHT + 4 * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING) / 2;
  assert.ok(path.includes(`${sourceCenter}`), `path ${path} should use the source card centre ${sourceCenter}`);
});

const commentedTables: DiagramTable[] = [
  {
    name: "copy_src",
    comment: "复制源表",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "主键ID" },
      { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "名称" },
      { name: "note", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
  },
  {
    name: "copy_dst",
    columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "目标主键" }],
    foreignKeys: [{ name: "copy_dst_id_fk", column: "id", ref_table: "copy_src", ref_column: "id" }],
  },
];

test("exports table and column comments onto the cards", () => {
  const relationships = buildDiagramRelationships(commentedTables);
  const positions = { copy_src: { x: 40, y: 40 }, copy_dst: { x: 460, y: 40 } };
  const svg = buildTableDiagramSvg({
    tables: commentedTables,
    relationships,
    positions,
    relationshipPaths: { [relationships[0].id]: "M 400 96 L 460 96" },
    canvas: { width: 900, height: 400 },
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });

  assert.match(svg, />复制源表</);
  assert.match(svg, />主键ID</);
  assert.match(svg, />名称</);
  assert.match(svg, />目标主键</);
  // Cards keep growing by one comment line per rendered table/column comment.
  assert.ok(svg.includes(`height="${diagramTableCardHeight(commentedTables[0])}"`));
  assert.ok(svg.includes(`height="${diagramTableCardHeight(commentedTables[1])}"`));
});

test("computeTableDiagramCanvas reserves room for the rendered comment lines", () => {
  const positions = { copy_src: { x: 0, y: 0 } };
  const canvas = computeTableDiagramCanvas([commentedTables[0]], positions, {
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  // 3 columns + 1 table comment + 2 column comments = 3 comment lines
  const expectedHeight = CARD_HEADER_HEIGHT + 3 * COLUMN_ROW_HEIGHT + CARD_BOTTOM_PADDING + 3 * COMMENT_LINE_HEIGHT;
  assert.equal(canvas.height, Math.ceil(expectedHeight + 2 * MARGIN));
});

test("relationship routing measures commented card heights", () => {
  const relationships = buildDiagramRelationships(commentedTables);
  const positions = { copy_src: { x: 0, y: 0 }, copy_dst: { x: 400, y: 0 } };
  const withComments = buildTableRelationshipPaths({
    relationships,
    positions,
    tables: commentedTables,
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  const withoutComments = buildTableRelationshipPaths({
    relationships,
    positions,
    tables: commentedTables.map((table) => ({ ...table, comment: null, columns: table.columns.map((column) => ({ ...column, comment: null })) })),
    cardWidth: CARD_WIDTH,
    cardHeaderHeight: CARD_HEADER_HEIGHT,
    columnRowHeight: COLUMN_ROW_HEIGHT,
  });
  assert.notEqual(withComments[relationships[0].id], withoutComments[relationships[0].id]);
});
