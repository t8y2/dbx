import { describe, expect, it } from "vitest";
import { buildXuguCompileSql, xuguCompileKeyword } from "@/lib/database/xuguCompileSql";

describe("xuguCompileSql", () => {
  it.each([
    ["procedure", "PROCEDURE"],
    ["function", "FUNCTION"],
    ["trigger", "TRIGGER"],
    ["package", "PACKAGE"],
    ["package-body", "PACKAGE"],
    ["type", "TYPE"],
    ["type-body", "TYPE"],
  ])("maps %s to %s", (objectType, keyword) => {
    expect(xuguCompileKeyword(objectType)).toBe(keyword);
  });

  it("quotes schema and object names while preserving mixed case", () => {
    expect(buildXuguCompileSql({ objectType: "procedure", schema: "AppSchema", name: "spCreateOrder" })).toBe('ALTER PROCEDURE "AppSchema"."spCreateOrder" RECOMPILE;');
  });

  it("accepts object-browser uppercase kinds", () => {
    expect(buildXuguCompileSql({ objectType: "FUNCTION", name: "f_get_count" })).toBe('ALTER FUNCTION "f_get_count" RECOMPILE;');
  });

  it("escapes embedded double quotes", () => {
    expect(buildXuguCompileSql({ objectType: "trigger", schema: 'A"Schema', name: 'T"1' })).toBe('ALTER TRIGGER "A""Schema"."T""1" RECOMPILE;');
  });

  it("returns null for unsupported object kinds or blank names", () => {
    expect(buildXuguCompileSql({ objectType: "sequence", schema: "SYSDBA", name: "SEQ_1" })).toBeNull();
    expect(buildXuguCompileSql({ objectType: "procedure", schema: "SYSDBA", name: "  " })).toBeNull();
  });
});
