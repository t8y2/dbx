import { describe, expect, it } from "vitest";
import { dataGridTotalRowCountLabelKey, dataGridTruncationHintKey, showDataGridRerunTotalCountAction } from "@/lib/dataGrid/dataGridPagination";
import DataGrid from "../DataGrid.vue";

type VuePropDefinition = { default?: unknown };
type VueComponentWithProps = { props?: Record<string, VuePropDefinition> };
type VueComponentWithSsrRender = { ssrRender?: unknown };

const statusRenderSource = (() => {
  const component = DataGrid as unknown as VueComponentWithSsrRender;
  return typeof component.ssrRender === "function" ? String(component.ssrRender) : "";
})();

const rerunBranch = (() => {
  const start = statusRenderSource.indexOf("} else if ($setup.showRerunTotalCountAction) {");
  return start === -1 ? "" : statusRenderSource.slice(start, statusRenderSource.indexOf("</button>", start));
})();

describe("DataGrid total row count exactness", () => {
  it("uses a VictoriaMetrics-specific truncation explanation", () => {
    expect(dataGridTruncationHintKey("victoriametrics")).toBe("grid.victoriaMetricsTruncatedHint");
    expect(dataGridTruncationHintKey("mysql")).toBe("grid.truncatedHint");
    expect(dataGridTruncationHintKey()).toBe("grid.truncatedHint");
  });

  it("treats totals as exact unless a caller explicitly marks them as a lower bound", () => {
    const component = DataGrid as unknown as VueComponentWithProps;
    expect(component.props?.totalRowCountIsExact?.default).toBe(true);
    expect(component.props?.inexactTotalRowCountMode?.default).toBe("at-least");
  });

  it("keeps lower-bound and estimated total labels distinct", () => {
    expect(dataGridTotalRowCountLabelKey(true, "estimated")).toBe("grid.totalRowCount");
    expect(dataGridTotalRowCountLabelKey(false, "at-least")).toBe("grid.totalRowCountAtLeast");
    expect(dataGridTotalRowCountLabelKey(false, "estimated")).toBe("grid.totalRowCountEstimated");
  });
});

describe("DataGrid rerun total row count action", () => {
  it("appears only for a displayed exact numeric total when counting is possible", () => {
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: 4200, totalRowCountIsExact: true })).toBe(true);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: 0, totalRowCountIsExact: true })).toBe(true);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, totalRowCountIsExact: true })).toBe(false);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: -1, totalRowCountIsExact: true })).toBe(false);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: false, displayedTotalRowCount: 4200, totalRowCountIsExact: true })).toBe(false);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: 4200, totalRowCountIsExact: false })).toBe(false);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: Infinity, totalRowCountIsExact: true })).toBe(false);
    expect(showDataGridRerunTotalCountAction({ canCalculateTotalRowCount: true, displayedTotalRowCount: NaN, totalRowCountIsExact: true })).toBe(false);
  });

  it("keeps the numeric total outside the action chain and orders busy, inline link, then rerun icon", () => {
    const numericTotal = statusRenderSource.indexOf('typeof $setup.displayedTotalRowCount === "number" && $setup.displayedTotalRowCount >= 0');
    const busyBranch = statusRenderSource.indexOf("if ($setup.totalRowCountBusy && !($setup.showRerunTotalCountAction && $setup.manualTotalRowCountLoading)) {");
    const inlineLink = statusRenderSource.indexOf("} else if ($setup.showExactTotalCountAction) {");
    const rerunAction = statusRenderSource.indexOf("} else if ($setup.showRerunTotalCountAction) {");
    expect(numericTotal).toBeGreaterThan(-1);
    expect(busyBranch).toBeGreaterThan(numericTotal);
    expect(inlineLink).toBeGreaterThan(busyBranch);
    expect(rerunAction).toBeGreaterThan(inlineLink);
  });

  it("renders a spaced rerun icon labelled for the total-count action and disabled while counting", () => {
    expect(rerunBranch).toContain('<button type="button" class="ml-1 inline-flex h-3.5 w-3.5');
    expect(rerunBranch).toContain("disabled:pointer-events-none");
    expect(rerunBranch).toContain("disabled:opacity-50");
    // title/aria-label toggle between idle and busy copy
    expect(rerunBranch).toContain('t("grid.calculateTotalRows")');
    expect(rerunBranch).toContain('t("grid.totalRowCountLoading")');
    expect(rerunBranch).toContain("disabled");
    expect(rerunBranch).toContain("aria-busy");
  });

  it("swaps the rerun icon for a spinner only while the manual count is in flight and hides decorative icons", () => {
    expect(rerunBranch).toContain("if ($setup.manualTotalRowCountLoading) {");
    expect(rerunBranch).toContain("Loader2");
    expect(rerunBranch).toContain("RefreshCcw");
    expect(rerunBranch).toContain("h-3 w-3 animate-spin");
    expect(rerunBranch).toContain("h-3 w-3");
    expect(rerunBranch).toContain("aria-hidden");
  });
});
