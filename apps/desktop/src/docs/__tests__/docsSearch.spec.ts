import { describe, expect, it } from "vitest";
import { searchDocs, type SearchHit } from "../docsSearch";
import type { DocTable, SchemaSnapshot } from "../types";

function column(name: string) {
  return {
    name,
    data_type: "text",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

function table(schema: string, name: string, columns: string[] = []): DocTable {
  return {
    schema,
    name,
    kind: "TABLE",
    columns: columns.map(column),
    indexes: [],
    foreignKeys: [],
    groupId: null,
    note: null,
    noteSource: "NONE",
    shadowedNote: null,
    columnNotes: {},
    estimatedRows: null,
    viewDefinition: null,
  };
}

const snapshot: SchemaSnapshot = {
  formatVersion: 1,
  project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
  tables: [
    table("public", "orders", ["status", "total"]),
    // `orders_count` contains "orders", so a query for "orders" matches BOTH
    // a table and a column — which is what makes the ranking test able to fail.
    table("public", "customers", ["status", "orders_count"]),
    // Mixed case, so a mutant that lowercases only the needle and not the
    // candidate would fail the case-insensitivity test.
    table("public", "Invoices", ["Amount"]),
  ],
  relationships: [],
  groups: [{ id: "g1", name: "Order Management", hue: 28, note: null }],
  enums: [{ schema: "public", name: "order_status", values: ["pending"], note: null, synthesized: false }],
  warnings: [],
};

// Columns outnumber every other kind by two orders of magnitude in a real
// database — the fixture answers "e" with 133 columns against 1 group and 12
// enums. This snapshot reproduces that shape: one term matching more of each
// kind than its cap allows.
const flooded: SchemaSnapshot = {
  formatVersion: 1,
  project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
  tables: [
    table(
      "public",
      "notes",
      Array.from({ length: 30 }, (_, index) => `note_${index}`),
    ),
  ],
  relationships: [],
  groups: Array.from({ length: 12 }, (_, index) => ({ id: `g${index}`, name: `note group ${index}`, hue: 28, note: null })),
  enums: Array.from({ length: 12 }, (_, index) => ({ schema: "public", name: `note_enum_${index}`, values: ["pending"], note: null, synthesized: false })),
  warnings: [],
};

describe("searchDocs", () => {
  it("returns nothing for an empty query", () => {
    expect(searchDocs(snapshot, "")).toEqual([]);
    expect(searchDocs(snapshot, "   ")).toEqual([]);
  });

  it("matches table names case-insensitively", () => {
    const hits = searchDocs(snapshot, "ORD");
    expect(hits.some((hit) => hit.kind === "table" && hit.label === "orders")).toBe(true);
  });

  it("matches columns and reports which table they belong to", () => {
    const hits = searchDocs(snapshot, "total");
    const hit = hits.find((candidate) => candidate.kind === "column");
    expect(hit).toBeDefined();
    expect(hit!.label).toBe("total");
    expect(hit!.context).toContain("orders");
  });

  it("returns one hit per table for a column name shared by several tables", () => {
    const hits = searchDocs(snapshot, "status").filter((hit) => hit.kind === "column");
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.context).sort()).toEqual(["public.customers", "public.orders"]);
  });

  it("matches groups and enums", () => {
    expect(searchDocs(snapshot, "Order Man").some((hit) => hit.kind === "group")).toBe(true);
    expect(searchDocs(snapshot, "order_status").some((hit) => hit.kind === "enum")).toBe(true);
  });

  it("ranks table matches above column matches for the same term", () => {
    // "orders" now matches the `orders` table AND the `orders_count` column
    // on `customers`. Reversing the concatenation order must fail this.
    const hits = searchDocs(snapshot, "orders");
    const firstTable = hits.findIndex((hit) => hit.kind === "table");
    const firstColumn = hits.findIndex((hit) => hit.kind === "column");
    expect(firstTable).toBeGreaterThanOrEqual(0);
    expect(firstColumn).toBeGreaterThanOrEqual(0);
    expect(firstTable).toBeLessThan(firstColumn);
  });

  it("carries a tableKey so a hit can navigate", () => {
    const hit = searchDocs(snapshot, "total").find((candidate) => candidate.kind === "column");
    expect(hit!.tableKey).toBe("public.orders");
  });

  it("still returns group and enum hits when columns flood the results", () => {
    // A single cap applied after concatenation deletes the tail of the list,
    // and groups and enums are the tail — making them unreachable through
    // search no matter what the user types.
    const hits = searchDocs(flooded, "note");
    expect(
      hits.some((hit) => hit.kind === "group"),
      "groups must survive a column flood",
    ).toBe(true);
    expect(
      hits.some((hit) => hit.kind === "enum"),
      "enums must survive a column flood",
    ).toBe(true);
  });

  it("caps each kind independently", () => {
    const hits = searchDocs(flooded, "note");
    const count = (kind: SearchHit["kind"]) => hits.filter((hit) => hit.kind === kind).length;
    expect(count("table")).toBe(1);
    expect(count("column")).toBe(20);
    expect(count("group")).toBe(10);
    expect(count("enum")).toBe(10);
  });

  it("matches a mixed-case identifier from a lowercase query", () => {
    // The candidate, not just the needle, must be lowercased — otherwise
    // search silently becomes case-sensitive for databases with quoted or
    // uppercase identifiers.
    expect(searchDocs(snapshot, "invoice").some((hit) => hit.label === "Invoices")).toBe(true);
    expect(searchDocs(snapshot, "amount").some((hit) => hit.label === "Amount")).toBe(true);
  });
});
