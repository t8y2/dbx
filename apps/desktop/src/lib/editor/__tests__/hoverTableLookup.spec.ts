import { describe, expect, it } from "vitest";
import { matchHoverTableCandidates, normalizeTableHoverLookupMode, pickHoverTableMatch, resolveHoverTableLookupTarget } from "@/lib/editor/hoverTableLookup";

describe("normalizeTableHoverLookupMode", () => {
  it("defaults to fallback", () => {
    expect(normalizeTableHoverLookupMode(undefined)).toBe("fallback");
    expect(normalizeTableHoverLookupMode("invalid")).toBe("fallback");
  });

  it("preserves valid modes", () => {
    expect(normalizeTableHoverLookupMode("current")).toBe("current");
    expect(normalizeTableHoverLookupMode("fallback")).toBe("fallback");
    expect(normalizeTableHoverLookupMode("always")).toBe("always");
  });
});

describe("resolveHoverTableLookupTarget", () => {
  it("uses schema.table qualifier regardless of mode", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["other", "users"],
      mode: "current",
    });
    expect(target).toMatchObject({
      database: "app",
      schema: "other",
      tableName: "users",
      schemaFromQualifier: true,
      allowGlobalFallback: false,
      preferGlobalFirst: false,
    });
  });

  it("uses db.schema.table qualifier", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["analytics", "reporting", "users"],
      mode: "fallback",
    });
    expect(target).toMatchObject({
      database: "analytics",
      schema: "reporting",
      tableName: "users",
      schemaFromQualifier: true,
      allowGlobalFallback: false,
    });
  });

  it("treats MySQL-style db.table as database qualifier", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      databaseType: "mysql",
      tableName: "users",
      identifierParts: ["other_db", "users"],
      mode: "fallback",
    });
    expect(target).toMatchObject({
      database: "other_db",
      schema: undefined,
      schemaFromQualifier: true,
      allowGlobalFallback: false,
    });
  });

  it("prefers semantic schema over identifier parts", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["t"],
      semanticSchema: "reporting",
      mode: "current",
    });
    expect(target).toMatchObject({
      schema: "reporting",
      schemaFromQualifier: true,
      allowGlobalFallback: false,
    });
  });

  it("scopes unqualified names to the selected schema in current mode", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["users"],
      mode: "current",
    });
    expect(target).toMatchObject({
      schema: "public",
      schemaFromQualifier: false,
      allowGlobalFallback: false,
      preferGlobalFirst: false,
    });
  });

  it("allows global fallback for unqualified names in fallback mode", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["users"],
      mode: "fallback",
    });
    expect(target).toMatchObject({
      schema: "public",
      allowGlobalFallback: true,
      preferGlobalFirst: false,
    });
  });

  it("prefers global search first in always mode", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["users"],
      mode: "always",
    });
    expect(target).toMatchObject({
      schema: undefined,
      allowGlobalFallback: true,
      preferGlobalFirst: true,
    });
  });
});

describe("pickHoverTableMatch", () => {
  const tables = [
    { name: "users", schema: "reporting" },
    { name: "users", schema: "public" },
    { name: "orders", schema: "public" },
  ];

  it("prefers the selected schema when multiple schemas match", () => {
    expect(pickHoverTableMatch("users", tables, "public")).toEqual({ name: "users", schema: "public" });
  });

  it("falls back to the first name match when preferred schema is absent", () => {
    expect(pickHoverTableMatch("users", tables, "missing")).toEqual({ name: "users", schema: "reporting" });
    expect(pickHoverTableMatch("users", tables)).toEqual({ name: "users", schema: "reporting" });
  });

  it("returns null when the table name is missing", () => {
    expect(pickHoverTableMatch("missing", tables, "public")).toBeNull();
  });
});

describe("matchHoverTableCandidates", () => {
  const tables = [
    { name: "users", schema: "reporting" },
    { name: "users", schema: "public" },
    { name: "orders", schema: "sales" },
  ];

  it("prefers the toolbar schema for unqualified names even when another schema appears first", () => {
    expect(
      matchHoverTableCandidates(tables, {
        lookups: ["users"],
        tableName: "users",
        preferredSchema: "public",
      }),
    ).toEqual({ name: "users", schema: "public" });
  });

  it("resolves qualified schema.table without using preferredSchema", () => {
    expect(
      matchHoverTableCandidates(tables, {
        lookups: ["reporting.users"],
        tableName: "users",
        preferredSchema: "public",
      }),
    ).toEqual({ name: "users", schema: "reporting" });
  });

  it("uses semantic qualified lookup before unqualified preferred-schema match", () => {
    expect(
      matchHoverTableCandidates(tables, {
        lookups: ["sales.orders", "orders"],
        tableName: "orders",
        preferredSchema: "public",
      }),
    ).toEqual({ name: "orders", schema: "sales" });
  });

  it("ignores unqualified lookups in the lookups list and still prefers schema", () => {
    // Unqualified entries must not short-circuit via matchTable's first-name-wins behavior.
    expect(
      matchHoverTableCandidates(tables, {
        lookups: ["users", "public.users"],
        tableName: "users",
        preferredSchema: "public",
      }),
    ).toEqual({ name: "users", schema: "public" });
  });

  it("returns null when nothing matches", () => {
    expect(
      matchHoverTableCandidates(tables, {
        lookups: ["missing.table"],
        tableName: "missing",
        preferredSchema: "public",
      }),
    ).toBeNull();
  });
});

describe("resolveHoverTableLookupTarget cache-scope modes", () => {
  it("fallback keeps selected schema for the first local pass", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["users"],
      mode: "fallback",
    });
    expect(target.schema).toBe("public");
    expect(target.preferGlobalFirst).toBe(false);
    expect(target.allowGlobalFallback).toBe(true);
  });

  it("always clears schema so local lookup scans same-database schemas", () => {
    const target = resolveHoverTableLookupTarget({
      database: "app",
      schema: "public",
      databaseType: "postgres",
      tableName: "users",
      identifierParts: ["users"],
      mode: "always",
    });
    expect(target.schema).toBeUndefined();
    expect(target.preferGlobalFirst).toBe(true);
  });

  it("qualified names never enable same-database global fallback", () => {
    for (const mode of ["current", "fallback", "always"] as const) {
      const target = resolveHoverTableLookupTarget({
        database: "app",
        schema: "public",
        databaseType: "postgres",
        tableName: "users",
        identifierParts: ["other", "users"],
        mode,
      });
      expect(target.allowGlobalFallback).toBe(false);
      expect(target.preferGlobalFirst).toBe(false);
      expect(target.schema).toBe("other");
    }
  });
});
