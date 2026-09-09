import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionSource(name: string, endMarker: string): string {
  const start = dataGridSource.indexOf(`function ${name}(`);
  const end = dataGridSource.indexOf(endMarker, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dataGridSource.slice(start, end);
}

describe("DataGrid tab-switch view snapshots", () => {
  const captureSource = functionSource("captureViewSelection", "function captureTabSwitchViewSnapshot(");
  const captureFnSource = functionSource("captureTabSwitchViewSnapshot", "function restoreTabSwitchViewSnapshot(");
  const restoreSource = functionSource("restoreTabSwitchViewSnapshot", "const multiRowCount = computed(");

  it("captures only with an owner key and a generation, and skips transpose", () => {
    expect(captureFnSource).toContain("if (!props.cacheKey || !props.viewGeneration) return;");
    expect(captureFnSource).toContain("if (showTranspose.value) return;");
    expect(captureFnSource).toContain("ownerKey: props.cacheKey");
    expect(captureFnSource).toContain("viewGeneration: props.viewGeneration");
    expect(captureFnSource).toContain("probe: currentViewProbe()");
  });

  it("captures the selection in O(selection size), never through the refresh identity scan", () => {
    // Copies refs directly instead of captureCurrentSelectionForRefresh, which
    // builds an identity token for every row (O(row count) on a large result).
    expect(captureFnSource).not.toContain("captureCurrentSelectionForRefresh");
    // Contiguous/all row selections serialize as a compact range instead of one
    // id per row, and the range helpers iterate only the selected ids via the
    // O(1) display index lookup — never the full displayItems.
    expect(captureSource).toContain("selectedRowCount === displayCount");
    expect(captureSource).toContain("selectedRowsContiguous(selectedRowIds.value)");
    expect(captureSource).toContain('kind: "all"');
    expect(captureSource).toContain("clampDataGridViewSelection(");
    const contiguousHelper = dataGridSource.slice(dataGridSource.indexOf("function selectedRowsContiguous("), dataGridSource.indexOf("function minimalRowRange("));
    expect(contiguousHelper).toContain("displayRowIndexById(rowId)");
    expect(contiguousHelper).toContain("max - min + 1 === count");
    expect(contiguousHelper).not.toContain("displayItems");
  });

  it("gates every restore on identity, renderer, and probe", () => {
    expect(restoreSource).toContain("if (!structuredFilterHydrationReady.value) return;");
    expect(restoreSource).toContain("if (snapshot.viewGeneration !== props.viewGeneration) return;");
    expect(restoreSource).toContain('if (snapshot.renderer !== (useCanvasGridRows.value ? "canvas" : "dom")) return;');
    expect(restoreSource).toContain("if (snapshot.probe !== currentViewProbe()) return;");
    expect(restoreSource).toContain("if (showTranspose.value) return;");
  });

  it("applies the index-based selection directly without scrolling it into view", () => {
    expect(restoreSource).toContain("restoreCellSelectionState({ cellKeys: new Set(capturedSelection.cellKeys) })");
    expect(restoreSource).toContain('selectedRowIds.value = new Set(indexes.map((index) => displayItems.value[index]?.id).filter((id): id is number => typeof id === "number"));');
    expect(restoreSource).toContain("selectedColumnIndexes.value = new Set(capturedSelection.columnIndexes);");
    expect(restoreSource).toContain("selectedRowIds.value = new Set(displayItems.value.map((item) => item.id));");
    expect(restoreSource).toContain("selection.lastClickedRowIndex.value = capturedSelection.anchorRowIndex;");
    expect(restoreSource).not.toContain("restoreSelectionAfterRefresh(snapshot");
  });

  it("clamps the restored viewport and consumes the snapshot after success", () => {
    expect(restoreSource).toContain("Math.min(Math.max(0, snapshot.viewport.top), maxTop)");
    expect(restoreSource).toContain("Math.min(Math.max(0, snapshot.viewport.left), maxLeft)");
    // A replayed snapshot is consumed so a later remount cannot re-apply it.
    expect(restoreSource).toContain("consumeDataGridViewSnapshot(ownerKey);");
  });

  it("settles the viewport over a bounded retry envelope instead of a fixed two frames", () => {
    // Immediate attempt, then nextTick, then at most 8 rAFs — mirroring
    // restoreScrollAcrossFrames. A fixed two-frame assumption intermittently
    // clamps the saved position to the top before virtualization measures.
    expect(restoreSource).toContain("if (attempt()) return;");
    expect(restoreSource).toContain("nextTick(() => {");
    expect(restoreSource).toContain("frames >= MAX_VIEW_SNAPSHOT_RESTORE_FRAMES");
    expect(restoreSource).toContain("viewSnapshotRestoreFrame = requestAnimationFrame(onFrame);");
    // An unmeasured scroller clamps the target to 0; that must not count as a
    // finished restore, or the saved position is lost at the top.
    expect(restoreSource).toContain("const roomForSavedTop = maxTop >= snapshot.viewport.top;");
    expect(restoreSource).toContain("return accepted && (snapshot.viewport.top === 0 || (roomForSavedTop && stable));");
    expect(dataGridSource).toContain("const MAX_VIEW_SNAPSHOT_RESTORE_FRAMES = 8;");
  });

  it("honours the rollback switch in both directions", () => {
    expect(captureFnSource).toContain("if (!DATA_GRID_VIEW_SNAPSHOT_RESTORE) return;");
    expect(restoreSource).toContain("if (!DATA_GRID_VIEW_SNAPSHOT_RESTORE) return;");
    expect(dataGridSource).toContain("cancelViewSnapshotRestoreFrame();");
  });

  it("wires capture to unmount and to the pre-tab-switch event", () => {
    expect(dataGridSource).toContain('window.addEventListener("dbx:before-tab-switch", captureTabSwitchViewSnapshot)');
    expect(dataGridSource).toContain('window.removeEventListener("dbx:before-tab-switch", captureTabSwitchViewSnapshot)');
    expect(dataGridSource).toContain("onUnmounted(() => {\n  // Capture before teardown");
    expect(dataGridSource).toContain("captureTabSwitchViewSnapshot();");
  });

  it("reports a dropped selection only after a successful restore", () => {
    // The capture must not toast while the user is leaving the tab.
    expect(captureFnSource).not.toContain("toast(");
    expect(restoreSource).toContain("snapshot.selectionDropped && shouldNotifyOverBudgetSelection(ownerKey");
    expect(restoreSource).toContain('toast(t("grid.viewSnapshotSelectionNotRestored")');
    // The notice stays one-shot per owner+generation.
    expect(dataGridSource).toContain("shouldNotifyOverBudgetSelection(ownerKey, props.viewGeneration!)");
  });

  it("retries after asynchronous structured-filter hydration", () => {
    expect(dataGridSource).toContain("structuredFilterHydrationReady.value = false;");
    expect(dataGridSource).toContain("structuredFilterHydrationReady.value = true;");
    expect(dataGridSource).toContain("nextTick(restoreTabSwitchViewSnapshot);");
    expect(dataGridSource).toContain("structuredFilterHydrationRequestId");
  });
});
