import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildDiagramDbml, buildDiagramJson, buildDiagramMermaid, diagramExportDialogFilter, diagramExportFileName, type DiagramJsonSnapshot } from "../../apps/desktop/src/lib/export/diagramFormats.ts";
import { buildDiagramRelationships, type DiagramRelationship, type DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";

const tables: DiagramTable[] = [
  {
    name: "users",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "created at", data_type: "timestamp with time zone", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
  },
  {
    name: "order-items",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
  },
];

function rel(partial: Pick<DiagramRelationship, "sourceCardinality" | "targetCardinality"> & Partial<Pick<DiagramRelationship, "id" | "sourceTable" | "sourceColumn" | "targetTable" | "targetColumn">>): DiagramRelationship {
  return {
    id: partial.id ?? "rel-1",
    sourceTable: partial.sourceTable ?? "users",
    sourceColumn: partial.sourceColumn ?? "id",
    targetTable: partial.targetTable ?? "order-items",
    targetColumn: partial.targetColumn ?? "user_id",
    sourceCardinality: partial.sourceCardinality,
    targetCardinality: partial.targetCardinality,
  };
}

test("diagramExportFileName builds safe names for each format and mode", () => {
  assert.equal(diagramExportFileName("", "", "table", "svg"), "dbx-diagram-table-structure.svg");
  assert.equal(diagramExportFileName("prod/main", "billing db", "engineering", "png"), "dbx-prod-main-billing-db-engineering-er.png");
  assert.equal(diagramExportFileName("a", "b", "table", "json"), "dbx-a-b-diagram.json");
  assert.equal(diagramExportFileName("a", "b", "table", "dbml"), "dbx-a-b-schema.dbml");
  assert.equal(diagramExportFileName("a", "b", "engineering", "mermaid"), "dbx-a-b-er.mmd");
});

test("buildDiagramJson pretty-prints with trailing newline", () => {
  const snapshot: DiagramJsonSnapshot = {
    meta: {
      connectionName: "local",
      database: "app",
      schema: "public",
      mode: "table",
      exportedAt: "2026-01-01T00:00:00.000Z",
    },
    tables: [],
    relationships: [],
    positions: {},
    layers: [],
    customRelationships: [],
    matchConfirms: [],
    matchIgnores: [],
  };
  const text = buildDiagramJson(snapshot);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), snapshot);
});

test("buildDiagramJson round-trips non-empty layers", () => {
  const snapshot: DiagramJsonSnapshot = {
    meta: {
      connectionName: "local",
      database: "app",
      schema: "public",
      mode: "table",
      exportedAt: "2026-01-01T00:00:00.000Z",
    },
    tables: [],
    relationships: [],
    positions: {},
    layers: [
      {
        id: "layer-1",
        name: "Core",
        color: "#3b82f6",
        tableNames: ["users"],
        collapsed: false,
        visible: true,
        layoutMode: "auto",
        position: { x: 40, y: 40 },
        width: 400,
        height: 240,
      },
    ],
    customRelationships: [],
    matchConfirms: [],
    matchIgnores: [],
  };
  const parsed = JSON.parse(buildDiagramJson(snapshot)) as DiagramJsonSnapshot;
  assert.equal(parsed.layers.length, 1);
  assert.deepEqual(parsed.layers[0], snapshot.layers[0]);
});

test("buildDiagramDbml emits tables, quoted types, and Ref operators", () => {
  const dbml = buildDiagramDbml(tables, [rel({ sourceCardinality: "1", targetCardinality: "1" }), rel({ id: "r2", sourceCardinality: "N", targetCardinality: "1" }), rel({ id: "r3", sourceCardinality: "1", targetCardinality: "N" }), rel({ id: "r4", sourceCardinality: "N", targetCardinality: "N" })]);

  assert.match(dbml, /Table users \{/);
  assert.match(dbml, /id bigint \[pk, not null\]/);
  assert.match(dbml, /"created at" "timestamp with time zone"/);
  assert.match(dbml, /Table "order-items"/);
  assert.match(dbml, /Ref: users\.id - "order-items"\.user_id/);
  assert.match(dbml, /Ref: users\.id > "order-items"\.user_id/);
  assert.match(dbml, /Ref: users\.id < "order-items"\.user_id/);
  assert.match(dbml, /Ref: users\.id <> "order-items"\.user_id/);
});

test("buildDiagramMermaid emits erDiagram entities, PK markers, and cardinalities", () => {
  const relationships = buildDiagramRelationships([
    tables[0],
    {
      ...tables[1],
      name: "orders",
      foreignKeys: [{ name: "fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
  ]);
  const mermaid = buildDiagramMermaid([tables[0], { ...tables[1], name: "orders", foreignKeys: [{ name: "fk", column: "user_id", ref_table: "users", ref_column: "id" }] }], relationships);

  assert.ok(mermaid.startsWith("erDiagram\n"));
  assert.match(mermaid, /bigint id PK/);
  assert.match(mermaid, /\}o--\|\|/);
});

test("buildDiagramMermaid maps all cardinality pairs", () => {
  const oneOne = buildDiagramMermaid(tables, [rel({ sourceCardinality: "1", targetCardinality: "1" })]);
  const oneN = buildDiagramMermaid(tables, [rel({ sourceCardinality: "1", targetCardinality: "N" })]);
  const nOne = buildDiagramMermaid(tables, [rel({ sourceCardinality: "N", targetCardinality: "1" })]);
  const nN = buildDiagramMermaid(tables, [rel({ sourceCardinality: "N", targetCardinality: "N" })]);

  assert.match(oneOne, /\|\|--\|\|/);
  assert.match(oneN, /\|\|--o\{/);
  assert.match(nOne, /\}o--\|\|/);
  assert.match(nN, /\}o--o\{/);
});

test("buildDiagramRelationships unique FK exports as 1:1 in Mermaid/DBML", () => {
  const profileTables: DiagramTable[] = [
    tables[0],
    {
      name: "profiles",
      columns: [{ name: "user_id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      foreignKeys: [{ name: "profiles_user_fk", column: "user_id", ref_table: "users", ref_column: "id" }],
    },
  ];
  const relationships = buildDiagramRelationships(profileTables);
  assert.equal(relationships[0].sourceCardinality, "1");
  assert.equal(relationships[0].targetCardinality, "1");
  assert.match(buildDiagramMermaid(profileTables, relationships), /\|\|--\|\|/);
  assert.match(buildDiagramDbml(profileTables, relationships), /Ref: profiles\.user_id - users\.id/);
});

test("buildDiagramDbml emits table and column notes with dbml-core escaping", () => {
  const commented: DiagramTable[] = [
    {
      name: "users",
      comment: "应用's 用户\n表",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "主键ID" },
        { name: "path", data_type: "varchar(255)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "it's a\\path" },
      ],
      foreignKeys: [],
    },
  ];

  const dbml = buildDiagramDbml(commented, []);

  // Plain note: single quotes, no escaping needed; note is the last bracket entry.
  assert.ok(dbml.includes("  id bigint [pk, not null, note: '主键ID']"));
  // Quotes/newlines/backslashes: backslashes doubled, ' escaped as \', triple-quoted.
  assert.ok(dbml.includes(String.raw`  path varchar(255) [note: '''it\'s a\\path''']`));
  assert.ok(dbml.includes(String.raw`  Note: '''应用\'s 用户`) && dbml.includes("\n表'''\n}"));
});

test("buildDiagramMermaid appends quoted column comments and %% table comment lines", () => {
  const commented: DiagramTable[] = [
    {
      name: "users",
      comment: "应用\n用户 表",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "主键ID" },
        { name: "path", data_type: "varchar(255)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "it's a\\path" },
        { name: "nickname", data_type: "varchar(64)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: '昵称 "外号"' },
      ],
      foreignKeys: [],
    },
  ];

  const mermaid = buildDiagramMermaid(commented, []);

  // Table comment rides on its own %% line right above the entity block; newlines collapse.
  assert.ok(mermaid.includes("  %% users: 应用 用户 表\n  users {"));
  // Column comments are double-quoted, follow the name/keys, and stay single-line.
  assert.ok(mermaid.includes('    bigint id PK "主键ID"'));
  assert.ok(mermaid.includes(String.raw`    varchar255 path "it's a\path"`));
  // Mermaid comments cannot contain double quotes, so they are swapped for single ones.
  assert.ok(mermaid.includes("    varchar64 nickname \"昵称 '外号'\""));
});

test("blank comments keep dbml and mermaid output byte-identical", () => {
  const blanked = tables.map((table) => ({
    ...table,
    comment: "   ",
    columns: table.columns.map((column) => ({ ...column, comment: "" })),
  }));
  assert.equal(buildDiagramDbml(blanked, []), buildDiagramDbml(tables, []));
  assert.equal(buildDiagramMermaid(blanked, []), buildDiagramMermaid(tables, []));
  const nulled = tables.map((table) => ({ ...table, comment: null, columns: table.columns.map((column) => ({ ...column, comment: null })) }));
  assert.equal(buildDiagramDbml(nulled, []), buildDiagramDbml(tables, []));
  assert.equal(buildDiagramMermaid(nulled, []), buildDiagramMermaid(tables, []));
});

test("diagramExportDialogFilter returns expected extensions", () => {
  assert.deepEqual(diagramExportDialogFilter("svg").extensions, ["svg"]);
  assert.deepEqual(diagramExportDialogFilter("png").extensions, ["png"]);
  assert.deepEqual(diagramExportDialogFilter("json").extensions, ["json"]);
  assert.deepEqual(diagramExportDialogFilter("dbml").extensions, ["dbml"]);
  assert.deepEqual(diagramExportDialogFilter("mermaid").extensions, ["mmd", "md"]);
});
