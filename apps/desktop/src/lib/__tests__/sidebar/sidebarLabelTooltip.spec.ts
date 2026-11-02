import { describe, expect, it } from "vitest";
import { shouldMeasureSidebarLabelOverflow } from "@/lib/sidebar/sidebarLabelTooltip";

describe("shouldMeasureSidebarLabelOverflow", () => {
  it("measures only plain truncated-label tooltip candidates", () => {
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: false, usesFullWidthLabel: false, tooltipsDisabled: false })).toBe(true);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: true, isRenaming: false, usesFullWidthLabel: false, tooltipsDisabled: false })).toBe(false);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: true, usesFullWidthLabel: false, tooltipsDisabled: false })).toBe(false);
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: false, usesFullWidthLabel: true, tooltipsDisabled: false })).toBe(false);
  });

  it("skips measuring when sidebar tooltips are disabled", () => {
    expect(shouldMeasureSidebarLabelOverflow({ hasDetailTooltip: false, isRenaming: false, usesFullWidthLabel: false, tooltipsDisabled: true })).toBe(false);
  });
});
