import { describe, expect, it } from "vitest";
import { createBoundedTextPreview } from "@/lib/common/boundedTextPreview";

describe("createBoundedTextPreview", () => {
  it("keeps short text unchanged", () => {
    const sql = "DROP TABLE IF EXISTS users;\nSELECT 1;";

    expect(createBoundedTextPreview(sql, { maxCharacters: 8192, maxLines: 200 })).toEqual({
      head: sql,
      tail: "",
      truncated: false,
      omittedCharacters: 0,
      omittedLines: 0,
      totalCharacters: sql.length,
      totalLines: 2,
    });
  });

  it("bounds a 40k-line preview by both characters and lines", () => {
    const sql = Array.from({ length: 40_000 }, (_, index) => `INSERT INTO t VALUES (${index});`).join("\n");
    const preview = createBoundedTextPreview(sql, { maxCharacters: 8192, maxLines: 200 });

    expect(preview.truncated).toBe(true);
    expect(preview.head.length + preview.tail.length).toBeLessThanOrEqual(8192);
    expect(preview.head.split("\n").length + preview.tail.split("\n").length).toBeLessThanOrEqual(200);
    expect(preview.head).toContain("VALUES (0)");
    expect(preview.tail).toContain("VALUES (39999)");
    expect(preview.omittedCharacters).toBeGreaterThan(1_000_000);
    expect(preview.omittedLines).toBeGreaterThanOrEqual(39_800);
  });
});
