import { describe, expect, it } from "vitest";
import { shouldMeasureSidebarLabelOverflow } from "@/lib/sidebarLabelTooltip";

describe("shouldMeasureSidebarLabelOverflow", () => {
  it("measures only plain truncated-label tooltip candidates", () => {
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: false, usesFullWidthLabel: false })).toBe(true);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: true, isRenaming: false, usesFullWidthLabel: false })).toBe(false);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: true, usesFullWidthLabel: false })).toBe(false);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: false, usesFullWidthLabel: true })).toBe(false);
  });
});
