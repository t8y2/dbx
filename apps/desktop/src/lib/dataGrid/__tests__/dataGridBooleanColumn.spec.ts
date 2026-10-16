import { describe, expect, it } from "vitest";
import { booleanCellDisplayText, normalizeBooleanCellValueStyle } from "@/lib/dataGrid/dataGridBooleanColumn";

describe("booleanCellDisplayText", () => {
  it("renders the uppercase TRUE/FALSE text by default", () => {
    expect(booleanCellDisplayText(true, "true-false")).toBe("TRUE");
    expect(booleanCellDisplayText(false, "true-false")).toBe("FALSE");
  });

  it("renders 1/0 when the zero-one style is selected", () => {
    expect(booleanCellDisplayText(true, "zero-one")).toBe("1");
    expect(booleanCellDisplayText(false, "zero-one")).toBe("0");
  });

  it("declines non-boolean values so the caller can keep its own formatting", () => {
    expect(booleanCellDisplayText(null, "zero-one")).toBeUndefined();
    expect(booleanCellDisplayText("true", "zero-one")).toBeUndefined();
    expect(booleanCellDisplayText(1, "zero-one")).toBeUndefined();
    expect(booleanCellDisplayText({}, "zero-one")).toBeUndefined();
  });
});

describe("normalizeBooleanCellValueStyle", () => {
  it("keeps known styles", () => {
    expect(normalizeBooleanCellValueStyle("zero-one")).toBe("zero-one");
    expect(normalizeBooleanCellValueStyle("true-false")).toBe("true-false");
  });

  it("falls back to true/false for unknown values", () => {
    expect(normalizeBooleanCellValueStyle(undefined)).toBe("true-false");
    expect(normalizeBooleanCellValueStyle("TRUE")).toBe("true-false");
    expect(normalizeBooleanCellValueStyle(0)).toBe("true-false");
  });
});
