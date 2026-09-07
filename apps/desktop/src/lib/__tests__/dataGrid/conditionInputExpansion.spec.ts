import { describe, expect, it } from "vitest";
import { shouldExpandConditionInput } from "@/lib/dataGrid/conditionInputExpansion";

describe("shouldExpandConditionInput", () => {
  const baseMetrics = {
    value: "where id in ()",
    textWidth: 100,
    contentHeight: 24,
    inputWidth: 200,
    inputHeight: 24,
  };

  it("expands for pasted multiline values even when the line width fits", () => {
    expect(
      shouldExpandConditionInput({
        ...baseMetrics,
        value: "where id in (60792411\n580019433\n1035062084)",
        contentHeight: 72,
      }),
    ).toBe(true);
  });

  it("keeps short single-line values collapsed", () => {
    expect(shouldExpandConditionInput(baseMetrics)).toBe(false);
  });

  it("expands when either horizontal or vertical content overflows", () => {
    expect(shouldExpandConditionInput({ ...baseMetrics, textWidth: 202 })).toBe(true);
    expect(shouldExpandConditionInput({ ...baseMetrics, contentHeight: 26 })).toBe(true);
  });
});
