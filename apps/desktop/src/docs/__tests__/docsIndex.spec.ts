import { describe, expect, it } from "vitest";
import { columnsUsingEnum, groupBySchema, groupByTableGroup } from "../docsIndex";
import type { DocTable, SchemaSnapshot, TableGroup } from "../types";

function table(schema: string | null, name: string, groupId: string | null = null): DocTable {
  return {
    schema,
    name,
    kind: "TABLE",
    columns: [],
    indexes: [],
    foreignKeys: [],
    groupId,
    note: null,
    noteSource: "NONE",
    shadowedNote: null,
    columnNotes: {},
    estimatedRows: null,
    viewDefinition: null,
  };
}

function snapshot(tables: DocTable[], groups: TableGroup[] = []): SchemaSnapshot {
  return {
    formatVersion: 1,
    project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
    tables,
    relationships: [],
    groups,
    enums: [],
    warnings: [],
  };
}

describe("groupBySchema", () => {
  it("groups tables under their schema, sorted by schema then name", () => {
    const sections = groupBySchema(snapshot([table("public", "orders"), table("analytics", "daily_sales"), table("public", "customers")]));

    expect(sections.map((section) => section.key)).toEqual(["analytics", "public"]);
    expect(sections[1].tables.map((t) => t.name)).toEqual(["customers", "orders"]);
  });

  it("puts schema-less tables in a single bare section", () => {
    const sections = groupBySchema(snapshot([table(null, "orders")]));
    expect(sections).toHaveLength(1);
    expect(sections[0].tables[0].name).toBe("orders");
  });

  it("tags every section with the schema fallback key", () => {
    // The render sites fall back to `translate(section.fallbackKey)` when
    // `label` is empty — schema sections must carry docs.noSchema, not the
    // sibling docs.noGroup key groupByTableGroup uses.
    const sections = groupBySchema(snapshot([table("public", "orders")]));
    expect(sections[0].fallbackKey).toBe("docs.noSchema");
  });
});

describe("groupByTableGroup", () => {
  const groups: TableGroup[] = [
    { id: "order-mgmt", name: "Order Management", hue: 28, note: "Checkout." },
    { id: "product-mgmt", name: "Product Management", hue: 148, note: null },
  ];

  it("groups tables by their group, preserving the snapshot's group order", () => {
    const sections = groupByTableGroup(snapshot([table("product", "products", "product-mgmt"), table("core", "orders", "order-mgmt")], groups));

    expect(sections.map((section) => section.key)).toEqual(["order-mgmt", "product-mgmt"]);
    expect(sections[0].label).toBe("Order Management");
    expect(sections[0].hue).toBe(28);
    expect(sections[0].note).toBe("Checkout.");
  });

  it("collects ungrouped tables into a trailing, unlabelled section", () => {
    const sections = groupByTableGroup(snapshot([table("core", "orders", "order-mgmt"), table("core", "users", null)], groups));

    const last = sections[sections.length - 1];
    expect(last.key).toBe("");
    // Empty, not a hardcoded "(no group)": the render sites translate this via
    // `translate(section.fallbackKey)` when `label` is falsy. A non-empty
    // English literal here would bypass that fallback and render untranslated
    // in every non-English locale — this guarded a real defect, not a
    // hypothetical one.
    expect(last.label).toBe("");
    expect(last.fallbackKey).toBe("docs.noGroup");
    expect(last.hue).toBeNull();
    expect(last.tables.map((t) => t.name)).toEqual(["users"]);
  });

  it("omits a group that has no members", () => {
    // render_group in the serializer skips empty groups; the viewer must not
    // show an empty header where the DBML shows nothing.
    const sections = groupByTableGroup(snapshot([table("core", "orders", "order-mgmt")], groups));
    expect(sections.map((section) => section.key)).not.toContain("product-mgmt");
  });

  it("treats a table whose groupId names no group as ungrouped", () => {
    const sections = groupByTableGroup(snapshot([table("core", "orders", "ghost")], groups));
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("");
  });
});

describe("columnsUsingEnum", () => {
  // The file's existing helper is `table(schema, name, groupId)` and builds a
  // table with NO columns, so these tests need columns attached. Add this
  // helper beside it rather than changing the existing signature — the other
  // tests in this file call it positionally.
  function withColumns(base: DocTable, columns: Array<{ name: string; type: string }>): DocTable {
    return {
      ...base,
      columns: columns.map((column) => ({
        name: column.name,
        data_type: column.type,
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        extra: "",
        comment: null,
        numeric_precision: null,
        numeric_scale: null,
        character_maximum_length: null,
      })),
    };
  }

  function snapshotOf(tables: DocTable[], enums: SchemaSnapshot["enums"]): SchemaSnapshot {
    return {
      formatVersion: 1,
      project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
      tables,
      relationships: [],
      groups: [],
      enums,
      warnings: [],
    };
  }

  it("finds every column using an enum, across tables", () => {
    const snapshot = snapshotOf(
      [withColumns(table("public", "orders"), [{ name: "status", type: "order_status" }]), withColumns(table("public", "returns"), [{ name: "state", type: "order_status" }]), withColumns(table("public", "users"), [{ name: "id", type: "integer" }])],
      [{ schema: "public", name: "order_status", values: ["new"], note: null, synthesized: false }],
    );

    expect(columnsUsingEnum(snapshot, "order_status")).toEqual([
      { tableKey: "public.orders", table: "orders", column: "status" },
      { tableKey: "public.returns", table: "returns", column: "state" },
    ]);
  });

  it("returns nothing for an enum no column references", () => {
    // Must not fall back to "every column". The `statement` column is the one
    // that matters: it is the only type here that *contains* `state`, so a
    // substring match would claim it while an unrelated type like `integer`
    // would not. Drop it and this test passes against `includes()` too, which
    // makes it stop guarding anything.
    const snapshot = snapshotOf(
      [
        withColumns(table("public", "users"), [
          { name: "id", type: "integer" },
          { name: "body", type: "statement" },
        ]),
      ],
      [{ schema: "public", name: "state", values: ["a"], note: null, synthesized: false }],
    );
    expect(columnsUsingEnum(snapshot, "state")).toEqual([]);
  });
});
