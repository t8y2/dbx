import { describe, expect, it } from "vitest";
import { firstLineCellDisplayValue } from "@/lib/dataGrid/cellValue";

describe("firstLineCellDisplayValue", () => {
  it("shows only the first line in fixed-height cells", () => {
    expect(firstLineCellDisplayValue("111\n222")).toBe("111");
    expect(firstLineCellDisplayValue("111\r\n222")).toBe("111");
    expect(firstLineCellDisplayValue("111\r222")).toBe("111");
  });
});
