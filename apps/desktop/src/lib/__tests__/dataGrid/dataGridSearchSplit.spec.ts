import { describe, expect, it } from "vitest";
import { clampSearchSplitWidth } from "@/lib/dataGrid/dataGridSearchSplit";

describe("data-grid search pane widths", () => {
  it("keeps the document browser's existing equal split by default", () => {
    expect(clampSearchSplitWidth({ containerWidth: 1000 })).toBe(500);
  });

  it.each([
    [1000, 700],
    [600, 420],
    [400, 220],
  ])("allocates more room to WHERE while reserving ORDER BY at width %i", (containerWidth, expected) => {
    expect(clampSearchSplitWidth({ containerWidth, defaultRatio: 0.7 })).toBe(expected);
  });

  it("uses the dragged width while clamping both panes", () => {
    expect(clampSearchSplitWidth({ containerWidth: 1000, defaultRatio: 0.7, desiredWidth: 600 })).toBe(600);
    expect(clampSearchSplitWidth({ containerWidth: 1000, defaultRatio: 0.7, desiredWidth: 950 })).toBe(820);
    expect(clampSearchSplitWidth({ containerWidth: 1000, defaultRatio: 0.7, desiredWidth: 50 })).toBe(180);
  });

  it("balances both panes in a narrow container even after dragging", () => {
    expect(clampSearchSplitWidth({ containerWidth: 300, defaultRatio: 0.7, desiredWidth: 700 })).toBe(150);
  });
});
