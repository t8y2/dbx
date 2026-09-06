import { describe, expect, it } from "vitest";
import { displayCellValue, firstLineCellDisplayValue } from "@/lib/dataGrid/cellValue";

describe("displayCellValue", () => {
  it("renders 64-bit integer strings beyond the JS safe range verbatim (issue #7832)", () => {
    // The Rust backend ships BIGINT cells above ±(2^53 - 1) as decimal
    // strings; the grid must keep every digit instead of routing them
    // through Number(), which zeroes the trailing digits.
    expect(displayCellValue("1391198305898897409")).toBe("1391198305898897409");
    expect(displayCellValue("18446744073709551615")).toBe("18446744073709551615");
    expect(displayCellValue("-9007199254740992")).toBe("-9007199254740992");
    // Safe-range integers keep crossing as JSON numbers.
    expect(displayCellValue(9007199254740991)).toBe("9007199254740991");
    expect(displayCellValue(42)).toBe("42");
  });
});

describe("firstLineCellDisplayValue", () => {
  it("shows only the first line in fixed-height cells", () => {
    expect(firstLineCellDisplayValue(null, false)).toBe(null);
    expect(firstLineCellDisplayValue("111\n222", false)).toBe("111");
    expect(firstLineCellDisplayValue("111\r\n222", false)).toBe("111");
    expect(firstLineCellDisplayValue("111\r222", false)).toBe("111");
    expect(firstLineCellDisplayValue("single line")).toBe("single line");

    expect(firstLineCellDisplayValue(null, true)).toBe(null);
    expect(firstLineCellDisplayValue("111\n222", true)).toBe("111¶222");
    expect(firstLineCellDisplayValue("111\r\n222", true)).toBe("111¶222");
    expect(firstLineCellDisplayValue("111\r222", true)).toBe("111¶222");
    expect(firstLineCellDisplayValue("single line", true)).toBe("single line");
  });

  it("skips leading blank lines without stripping content indentation", () => {
    expect(firstLineCellDisplayValue("\nINNODB MONITOR OUTPUT\nbody", false)).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("\r\nINNODB MONITOR OUTPUT\r\nbody", false)).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("\rINNODB MONITOR OUTPUT\rbody", false)).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("  \n  indented content\nbody", false)).toBe("  indented content");

    expect(firstLineCellDisplayValue("\nINNODB MONITOR OUTPUT\nbody", true)).toBe("¶INNODB MONITOR OUTPUT¶body");
    expect(firstLineCellDisplayValue("\r\nINNODB MONITOR OUTPUT\r\nbody", true)).toBe("¶INNODB MONITOR OUTPUT¶body");
    expect(firstLineCellDisplayValue("\rINNODB MONITOR OUTPUT\rbody", true)).toBe("¶INNODB MONITOR OUTPUT¶body");
    expect(firstLineCellDisplayValue("  \n  indented content\nbody", true)).toBe("  ¶  indented content¶body");
  });

  it("preserves values that do not contain a content line", () => {
    expect(firstLineCellDisplayValue("", false)).toBe("");
    expect(firstLineCellDisplayValue("   ", false)).toBe("   ");
    expect(firstLineCellDisplayValue("\n\r\n  \r", false)).toBe("\n\r\n  \r");

    expect(firstLineCellDisplayValue("", true)).toBe("");
    expect(firstLineCellDisplayValue("   ", true)).toBe("   ");
    expect(firstLineCellDisplayValue("\n\r\n  \r", true)).toBe("¶¶  ¶");
  });
});
