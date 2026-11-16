import { describe, expect, it } from "vitest";
import { encodeSpreadsheetTsvCell } from "@/lib/common/spreadsheetTsv";

describe("encodeSpreadsheetTsvCell", () => {
  it("preserves legal decimal and at-sign text while guarding formulas", () => {
    expect(encodeSpreadsheetTsvCell(undefined)).toBe("");
    expect(encodeSpreadsheetTsvCell("-123.45")).toBe("-123.45");
    expect(encodeSpreadsheetTsvCell("-1234567890123456")).toBe("'-1234567890123456");
    expect(encodeSpreadsheetTsvCell("@")).toBe("@");
    expect(encodeSpreadsheetTsvCell("@ASCII")).toBe("'@ASCII");
    expect(encodeSpreadsheetTsvCell("@冯十二")).toBe("@冯十二");
    expect(encodeSpreadsheetTsvCell("=1+1")).toBe("'=1+1");
  });

  it.each([
    ["", ""],
    ["-123456789012345", "-123456789012345"],
    ["  +1", "'  +1"],
    ["-1e3", "'-1e3"],
    ["\t=1", `"'\t=1"`],
    ["\r=1", `"'\r=1"`],
    ["  @", "  @"],
  ])("preserves the formula guard boundary for %j", (input, expected) => {
    expect(encodeSpreadsheetTsvCell(input)).toBe(expected);
  });

  it("guards before TSV quoting and doubles embedded quotes", () => {
    expect(encodeSpreadsheetTsvCell('=a\t"b')).toBe(`"'=a\t""b"`);
    expect(encodeSpreadsheetTsvCell("x\r\ny")).toBe('"x\r\ny"');
  });
});
