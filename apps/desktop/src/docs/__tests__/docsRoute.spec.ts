import { describe, expect, it } from "vitest";
import { formatDocsHash, parseDocsHash } from "../docsRoute";
import type { SchemaSnapshot } from "../types";

// `formatVersion` is top-level on SchemaSnapshot, not inside `project`.
const snapshot = {
  formatVersion: 1,
  project: { name: "shop", databaseType: "postgres", database: "shop", schemas: ["public"], generatedAt: "2026-08-06T00:00:00Z", note: null },
  tables: [
    { schema: "public", name: "orders", columns: [], indexes: [] },
    { schema: null, name: "a/b", columns: [], indexes: [] },
  ],
  enums: [{ schema: "public", name: "order_status", values: ["pending"] }],
  relationships: [],
  groups: [],
  warnings: [],
} as unknown as SchemaSnapshot;

describe("parseDocsHash", () => {
  it("reads a table route", () => {
    expect(parseDocsHash("#/table/public.orders", snapshot, true)).toEqual({ kind: "table", key: "public.orders" });
  });

  it("decodes an identifier containing a slash", () => {
    // A table named `a/b` must survive the round trip; an undecoded hash
    // would split into a bogus segment and silently fall back to the index.
    expect(parseDocsHash("#/table/a%2Fb", snapshot, true)).toEqual({ kind: "table", key: "a/b" });
  });

  it("reads an enum route", () => {
    expect(parseDocsHash("#/enum/order_status", snapshot, true)).toEqual({ kind: "enum", name: "order_status" });
  });

  it("falls back to the index for a table that is not in the snapshot", () => {
    // A deep link into a since-dropped table is the EXPECTED case for a file
    // someone saved months ago. It must never render a blank page.
    expect(parseDocsHash("#/table/public.gone", snapshot, true)).toEqual({ kind: "index" });
  });

  it("falls back to the index for junk, empty and bare hashes", () => {
    for (const hash of ["", "#", "#/", "#/nonsense", "#/table", "#/table/", "not-a-hash"]) {
      expect(parseDocsHash(hash, snapshot, true), hash).toEqual({ kind: "index" });
    }
  });

  it("refuses the diagram route when the host has not enabled it", () => {
    // The dialog passes diagram="external" and keeps its button to the full
    // SchemaDiagramDialog. A hash must not render a view that host declined.
    expect(parseDocsHash("#/diagram", snapshot, false)).toEqual({ kind: "index" });
    expect(parseDocsHash("#/diagram", snapshot, true)).toEqual({ kind: "diagram" });
  });
});

describe("formatDocsHash", () => {
  it("round-trips every route kind", () => {
    for (const route of [{ kind: "index" }, { kind: "table", key: "public.orders" }, { kind: "enum", name: "order_status" }, { kind: "diagram" }] as const) {
      expect(parseDocsHash(formatDocsHash(route), snapshot, true)).toEqual(route);
    }
  });

  it("encodes a slash in an identifier", () => {
    expect(formatDocsHash({ kind: "table", key: "a/b" })).toBe("#/table/a%2Fb");
  });
});
