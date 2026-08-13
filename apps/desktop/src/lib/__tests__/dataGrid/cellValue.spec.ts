import { describe, expect, it } from "vitest";
import { firstLineCellDisplayValue } from "@/lib/dataGrid/cellValue";

describe("firstLineCellDisplayValue", () => {
  it("shows only the first line in fixed-height cells", () => {
    expect(firstLineCellDisplayValue("111\n222")).toBe("111");
    expect(firstLineCellDisplayValue("111\r\n222")).toBe("111");
    expect(firstLineCellDisplayValue("111\r222")).toBe("111");
    expect(firstLineCellDisplayValue("single line")).toBe("single line");
  });

  it("skips leading blank lines without stripping content indentation", () => {
    expect(firstLineCellDisplayValue("\nINNODB MONITOR OUTPUT\nbody")).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("\r\nINNODB MONITOR OUTPUT\r\nbody")).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("\rINNODB MONITOR OUTPUT\rbody")).toBe("INNODB MONITOR OUTPUT");
    expect(firstLineCellDisplayValue("  \n  indented content\nbody")).toBe("  indented content");
  });

  it("preserves values that do not contain a content line", () => {
    expect(firstLineCellDisplayValue("")).toBe("");
    expect(firstLineCellDisplayValue("   ")).toBe("   ");
    expect(firstLineCellDisplayValue("\n\r\n  \r")).toBe("\n\r\n  \r");
  });
});
