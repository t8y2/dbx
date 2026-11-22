import { describe, expect, it } from "vitest";
import { CELL_TRANSFORM_KINDS, transformCellValue } from "@/lib/dataGrid/cellValueTransform";

describe("transformCellValue flattenLines (#14960)", () => {
  it("joins wrapped lines with a single space and trims each line", () => {
    const result = transformCellValue("  first line\n\tsecond  line  \nthird", { kind: "flattenLines" });
    expect(result).toEqual({ ok: true, text: "first line second  line third" });
  });

  it("normalizes CRLF and lone CR line endings", () => {
    expect(transformCellValue("a\r\nb\rc\nd", { kind: "flattenLines" })).toEqual({ ok: true, text: "a b c d" });
  });

  it("drops blank lines instead of leaving double spaces", () => {
    expect(transformCellValue("head\n\n\nmiddle\n   \ntail", { kind: "flattenLines" })).toEqual({ ok: true, text: "head middle tail" });
  });

  it("collapses a single-line value to its trimmed self", () => {
    expect(transformCellValue("  only  ", { kind: "flattenLines" })).toEqual({ ok: true, text: "only" });
  });

  it("flattens a fully blank value to an empty string", () => {
    expect(transformCellValue("\n \r\n\t", { kind: "flattenLines" })).toEqual({ ok: true, text: "" });
  });

  it("is listed among the transform kinds offered in the dialog", () => {
    expect(CELL_TRANSFORM_KINDS).toContain("flattenLines");
  });
});
