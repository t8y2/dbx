import { describe, expect, it } from "vitest";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments } from "../xlsxHeader";

describe("xlsxHeader", () => {
  it("builds comment-only and combined header overrides", () => {
    const columns = ["id", "name", "created_at"];
    const comments = [" Identifier ", "", undefined];

    expect(buildXlsxHeaderOverrides(columns, comments, "comment")).toEqual(["Identifier", null, null]);
    expect(buildXlsxHeaderOverrides(columns, comments, "name-comment")).toEqual(["id (Identifier)", null, null]);
  });

  it("keeps name mode and comment-less exports on the original headers", () => {
    expect(buildXlsxHeaderOverrides(["id"], ["Identifier"], "name")).toBeUndefined();
    expect(buildXlsxHeaderOverrides(["id"], ["  "], "name-comment")).toBeUndefined();
    expect(hasXlsxHeaderComments([undefined, "  ", "Name"])).toBe(true);
    expect(hasXlsxHeaderComments([undefined, "  "])).toBe(false);
  });
});
