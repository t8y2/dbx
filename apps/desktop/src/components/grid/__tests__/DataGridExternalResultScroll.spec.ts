import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function resultWatchSource(): string {
  const start = dataGridSource.indexOf("watch(\n  () => props.result,\n  (result, previousResult) => {");
  const end = dataGridSource.indexOf("// --- Context menu handlers ---");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dataGridSource.slice(start, end);
}

function captureViewportAnchorForRefreshSource(): string {
  const start = dataGridSource.indexOf("function captureViewportAnchorForRefresh()");
  const end = dataGridSource.indexOf("function restoreViewportAnchorAfterRefresh(");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dataGridSource.slice(start, end);
}

describe("DataGrid result-replacement vertical scroll", () => {
  it("resets to the first row when the result is replaced without an internal grid action", () => {
    const watchSource = resultWatchSource();

    expect(watchSource).toContain("} else if (!inPlaceRefreshPending) {");
    const externalBranch = watchSource.slice(watchSource.indexOf("} else if (!inPlaceRefreshPending) {"));
    expect(externalBranch.indexOf("resetGridVerticalScroll();")).toBeGreaterThanOrEqual(0);
    expect(externalBranch).toContain("#7341");
  });

  it("keeps the internal-action reset flag path unchanged", () => {
    const watchSource = resultWatchSource();

    expect(watchSource).toContain("if (getResetScrollAfterResult()) {\n      clearResetScrollAfterResult();\n      resetGridVerticalScroll();");
  });

  it("treats any pending prepareFullReload marker as an in-place refresh that keeps the viewport", () => {
    const watchSource = resultWatchSource();

    expect(watchSource).toContain("preservedSelectionOnNextResult !== null || preservedViewportAnchorOnNextResult !== null || preservedDetailsOnNextResult !== null || preserveTransposeOnNextResult.value");
    // The pending-marker check must run before the watch consumes the markers.
    const pendingCheck = watchSource.indexOf("const inPlaceRefreshPending =");
    const selectionConsume = watchSource.indexOf("preservedSelectionOnNextResult = null;");
    const anchorConsume = watchSource.indexOf("preservedViewportAnchorOnNextResult = null;");
    const detailsConsume = watchSource.indexOf("preservedDetailsOnNextResult = null;");
    const transposeConsume = watchSource.indexOf("preserveTransposeOnNextResult.value = false;");
    expect(pendingCheck).toBeGreaterThanOrEqual(0);
    for (const consume of [selectionConsume, anchorConsume, detailsConsume, transposeConsume]) {
      expect(consume).toBeGreaterThan(pendingCheck);
    }
  });

  it("returns before any scroll reset when the replacement completes an infinite-scroll append", () => {
    const watchSource = resultWatchSource();

    const appendReturn = watchSource.indexOf("if (appendCompletion) {");
    const appendEarlyReturn = watchSource.indexOf("return;\n    }");
    const resetBranch = watchSource.indexOf("if (getResetScrollAfterResult()) {");
    expect(appendReturn).toBeGreaterThanOrEqual(0);
    expect(appendEarlyReturn).toBeGreaterThan(appendReturn);
    expect(resetBranch).toBeGreaterThan(appendEarlyReturn);
  });

  it("does not anchor a toolbar refresh to the current top row when already scrolled to the top (#8339)", () => {
    // Anchoring the row that happens to be at scrollTop 0 would re-pin it to the
    // same on-screen offset after refresh, which pushes newly inserted rows
    // (e.g. rows prepended by an external insert under a DESC sort) above the
    // visible viewport instead of showing them. Skipping the anchor when already
    // at the top lets the toolbar-refresh path land on the freshest first row.
    const anchorSource = captureViewportAnchorForRefreshSource();

    expect(anchorSource).toContain("#8339");
    const guard = anchorSource.indexOf("if (scroller.scrollTop <= 0) return null;");
    const rowHeightUse = anchorSource.indexOf("const rowHeight =");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(rowHeightUse).toBeGreaterThan(guard);
  });
});
