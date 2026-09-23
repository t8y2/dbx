import { describe, expect, it } from "vitest";
import { formatTsv } from "@/lib/export/exportFormats";

describe("formatTsv", () => {
  it("copies a value that only contains double quotes verbatim (#10087)", () => {
    const output = formatTsv(["id", "mag"], [[1, '"9932b4d2ad1c4ff88b5bfe1690ee1bb8"']]);

    expect(output).toBe('id\tmag\n1\t"9932b4d2ad1c4ff88b5bfe1690ee1bb8"');
  });

  it("still quotes values containing a tab or newline so the TSV shape survives", () => {
    const output = formatTsv(["v"], [["a\tb"], ["c\nd"]]);

    expect(output).toBe('v\n"a\tb"\n"c\nd"');
  });

  it("renders NULL as an empty field without adding quotes", () => {
    const output = formatTsv(["id", "name"], [[1, null]]);

    expect(output).toBe("id\tname\n1\t");
  });
});
