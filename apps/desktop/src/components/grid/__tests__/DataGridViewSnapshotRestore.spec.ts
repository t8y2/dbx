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
  const captureSource = functionSource("captureTabSwitchViewSnapshot", "function restoreTabSwitchViewSnapshot(");
  const restoreSource = functionSource("restoreTabSwitchViewSnapshot", "const multiRowCount = computed(");

  it("captures only with an owner key and a generation, and skips transpose", () => {
    expect(captureSource).toContain("if (!props.cacheKey || !props.viewGeneration) return;");
    expect(captureSource).toContain("if (showTranspose.value) return;");
    expect(captureSource).toContain("ownerKey: props.cacheKey");
    expect(captureSource).toContain("viewGeneration: props.viewGeneration");
    expect(captureSource).toContain("probe: currentViewProbe()");
  });

  it("gates every restore on identity, renderer, and probe", () => {
    expect(restoreSource).toContain("if (snapshot.viewGeneration !== props.viewGeneration) return;");
    expect(restoreSource).toContain('if (snapshot.renderer !== (useCanvasGridRows.value ? "canvas" : "dom")) return;');
    expect(restoreSource).toContain("if (snapshot.probe !== currentViewProbe()) return;");
    expect(restoreSource).toContain("if (showTranspose.value) return;");
  });

  it("clamps the restored viewport and applies the selection without scrolling it into view", () => {
    expect(restoreSource).toContain("Math.min(Math.max(0, snapshot.viewport.top), maxTop)");
    expect(restoreSource).toContain("Math.min(Math.max(0, snapshot.viewport.left), maxLeft)");
    expect(restoreSource).toContain("restoreSelectionAfterRefresh(snapshot.selection, { scroll: false })");
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
    expect(captureSource).toContain("if (!DATA_GRID_VIEW_SNAPSHOT_RESTORE) return;");
    expect(restoreSource).toContain("if (!DATA_GRID_VIEW_SNAPSHOT_RESTORE) return;");
    expect(dataGridSource).toContain("cancelViewSnapshotRestoreFrame();");
  });

  it("wires capture to unmount and to the pre-tab-switch event", () => {
    expect(dataGridSource).toContain('window.addEventListener("dbx:before-tab-switch", captureTabSwitchViewSnapshot)');
    expect(dataGridSource).toContain('window.removeEventListener("dbx:before-tab-switch", captureTabSwitchViewSnapshot)');
    expect(dataGridSource).toContain("onUnmounted(() => {\n  // Capture before teardown");
    expect(dataGridSource).toContain("captureTabSwitchViewSnapshot();");
  });

  it("notifies once per owner and generation when a selection was dropped", () => {
    expect(captureSource).toContain("shouldNotifyOverBudgetSelection(props.cacheKey, props.viewGeneration)");
    expect(captureSource).toContain('toast(t("grid.viewSnapshotSelectionNotRestored")');
  });
});
