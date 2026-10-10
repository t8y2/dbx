import { describe, expect, it } from "vitest";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments, xlsxHeaderUsesCommentRows } from "../xlsxHeader";

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

  it("passes raw comments through for the two-row header mode", () => {
    const columns = ["id", "name", "created_at"];
    const comments = [" Identifier ", "", undefined];

    // The comments ride along as plain data (paired with the headerCommentRows
    // flag) instead of overriding the header text.
    expect(buildXlsxHeaderOverrides(columns, comments, "name-comment-rows")).toEqual(["Identifier", null, null]);
    expect(buildXlsxHeaderOverrides(["id"], ["  "], "name-comment-rows")).toBeUndefined();
    expect(xlsxHeaderUsesCommentRows("name-comment-rows")).toBe(true);
    expect(xlsxHeaderUsesCommentRows("name")).toBe(false);
    expect(xlsxHeaderUsesCommentRows("comment")).toBe(false);
    expect(xlsxHeaderUsesCommentRows("name-comment")).toBe(false);
  });
});
