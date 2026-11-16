import { describe, expect, it } from "vitest";
import { buildDamengCompileViewSql } from "@/lib/database/damengCompileSql";

describe("buildDamengCompileViewSql", () => {
  it("quotes schema and view identifiers", () => {
    expect(buildDamengCompileViewSql({ schema: "APP", name: "ACTIVE_VIEW" })).toBe('ALTER VIEW "APP"."ACTIVE_VIEW" COMPILE;');
  });

  it("escapes embedded double quotes", () => {
    expect(buildDamengCompileViewSql({ schema: 'APP"DATA', name: 'V"ACTIVE' })).toBe('ALTER VIEW "APP""DATA"."V""ACTIVE" COMPILE;');
  });

  it("allows a database-level name when no schema is supplied", () => {
    expect(buildDamengCompileViewSql({ name: "ACTIVE_VIEW" })).toBe('ALTER VIEW "ACTIVE_VIEW" COMPILE;');
  });

  it("rejects a blank view name", () => {
    expect(buildDamengCompileViewSql({ schema: "APP", name: "  " })).toBeNull();
  });
});
