import { describe, expect, it } from "vitest";
import { nextResultToolbarLayout } from "@/lib/tabs/resultToolbarLayout";

describe("nextResultToolbarLayout", () => {
  it("never compacts fewer than two results", () => {
    expect(nextResultToolbarLayout({ resultCount: 1, compact: true, expandedRequiredWidth: 900, toolbarWidth: 700, tabsViewportWidth: 100, tabsContentWidth: 300 })).toEqual({ compact: false });
  });

  it("keeps the expanded layout when tabs fit", () => {
    expect(nextResultToolbarLayout({ resultCount: 2, compact: false, toolbarWidth: 800, tabsViewportWidth: 300, tabsContentWidth: 300 })).toEqual({ compact: false });
  });

  it("compacts on overflow and records the expanded width requirement", () => {
    expect(nextResultToolbarLayout({ resultCount: 3, compact: false, toolbarWidth: 800, tabsViewportWidth: 240, tabsContentWidth: 300 })).toEqual({ compact: true, expandedRequiredWidth: 860 });
  });

  it("stays compact after compact controls remove the current overflow", () => {
    expect(nextResultToolbarLayout({ resultCount: 3, compact: true, expandedRequiredWidth: 860, toolbarWidth: 850, tabsViewportWidth: 320, tabsContentWidth: 300 })).toEqual({ compact: true, expandedRequiredWidth: 860 });
  });

  it("expands only after the required width and hysteresis are available", () => {
    expect(nextResultToolbarLayout({ resultCount: 3, compact: true, expandedRequiredWidth: 860, toolbarWidth: 867, tabsViewportWidth: 337, tabsContentWidth: 300 })).toEqual({ compact: true, expandedRequiredWidth: 860 });
    expect(nextResultToolbarLayout({ resultCount: 3, compact: true, expandedRequiredWidth: 860, toolbarWidth: 868, tabsViewportWidth: 338, tabsContentWidth: 300 })).toEqual({ compact: false });
  });
});
