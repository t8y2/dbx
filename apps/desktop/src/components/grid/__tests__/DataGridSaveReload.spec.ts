import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  const relativeEnd = dataGridSource.slice(start).search(new RegExp(`\\n(?:async\\s+)?function\\s+${nextName}\\b`));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(relativeEnd).toBeGreaterThan(0);
  return dataGridSource.slice(start, start + relativeEnd);
}

describe("DataGrid save reload integration", () => {
  it("shares the toolbar full-reload preparation with editor saves", () => {
    const prepareSource = functionSource("prepareFullReload", "onToolbarRefresh");
    const toolbarSource = functionSource("onToolbarRefresh", "setAutoRefreshInterval");
    const rollbackSource = functionSource("onToolbarRollback", "addRow");

    expect(dataGridSource).toContain("prepareFullReload,\n  emit,");
    expect(dataGridSource).toContain("refreshSavedRows,\n  onCellValueChanged");
    expect(toolbarSource).toContain("prepareFullReload();");
    expect(rollbackSource).toContain("prepareFullReload();");
    expect(toolbarSource).toContain("const resetToFirstPage = hasPendingConditionInputs();");
    expect(toolbarSource).toContain("resetToFirstPage ? 0 : (currentPage.value - 1) * pageSize.value");
    expect(prepareSource).toContain("resetInfiniteScrollState();");
    expect(prepareSource).toContain("captureViewportAnchorForRefresh();");
    expect(prepareSource).toContain("preservedViewportAnchorOnNextResult = viewportAnchor ? { anchor: viewportAnchor, sourceResult: props.result } : null;");
    expect(prepareSource).toContain("captureCurrentSelectionForRefresh();");
    expect(prepareSource).toContain("preservedSelectionOnNextResult = selection ? { selection, sourceResult: props.result } : null;");
    expect(prepareSource).toContain("preservedDetailsOnNextResult = captureDetailsForRefresh();");
    expect(prepareSource).toContain("preserveTransposeOnNextResult.value = showTranspose.value;");
    expect(dataGridSource).toContain("if (detailsSnapshot) restoreDetailsAfterRefresh(detailsSnapshot);");
    expect(dataGridSource).toContain("if (viewportAnchorSnapshot) restoreViewportAnchorAfterRefresh(viewportAnchorSnapshot);");
  });

  it("resets accumulated infinite-scroll pagination before reloading from offset zero", () => {
    const resetSource = functionSource("resetInfiniteScrollState", "prepareFullReload");
    const nextPageSource = functionSource("infiniteScrollNextPage", "checkInfiniteScroll");

    expect(resetSource).toContain("currentPage.value = 1;");
    expect(resetSource).toContain("lastInfiniteScrollPage = 0;");
    expect(resetSource).toContain("infiniteScrollRequestedOffset = undefined;");
    expect(resetSource).toContain("infiniteScrollRequestedLimit = undefined;");
    expect(nextPageSource).toContain("const nextOffset = props.result.rows.length;");
    expect(nextPageSource).toContain('emit("paginate", nextOffset, nextLimit, currentWhereInput(), currentOrderBy());');
  });
});
