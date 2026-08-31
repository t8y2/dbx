import { describe, expect, it } from "vitest";
import { firstLineCellDisplayValue } from "@/lib/dataGrid/cellValue";

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
