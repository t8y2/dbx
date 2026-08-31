import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid cell detail selection", () => {
  it("keeps Canvas hover state while the renderer swaps drawing surfaces", () => {
    expect(dataGridSource).toContain("function isCanvasGridInteractionTarget(target: Node): boolean");
    expect(dataGridSource).toContain("canvasOverlayRef.value?.contains(target) === true");
    expect(dataGridSource).toContain("canvasRef.value?.contains(target) === true");
    expect(dataGridSource).toContain("canvasBackRef.value?.contains(target) === true");

    const canvasLeave = dataGridSource.match(/function onCanvasMouseLeave[\s\S]*?\n\}/)?.[0];
    const detailLeave = dataGridSource.match(/function clearCanvasDetailHover[\s\S]*?\n\}/)?.[0];
    expect(canvasLeave).toContain("isCanvasGridInteractionTarget(relatedTarget)");
    expect(detailLeave).toContain("isCanvasGridInteractionTarget(relatedTarget)");
  });

  it("gates only the three hover Info buttons with the visibility setting", () => {
    expect(dataGridSource).toContain("const cellDetailButtonEnabled = computed(() => settingsStore.editorSettings.dataGridCellDetailButtonVisible);");
    expect(dataGridSource.match(/v-if="cellDetailButtonEnabled"/g)).toHaveLength(3);
    expect(dataGridSource.match(/v-if="cellDetailButtonVisible\(/g)).toHaveLength(2);

    const hoverVisibility = dataGridSource.match(/function cellDetailButtonVisible[\s\S]*?\n\}/)?.[0];
    expect(hoverVisibility).toBeDefined();
    expect(hoverVisibility).not.toContain("dataGridCellDetailButtonVisible");
  });

  it("removes the Canvas action overlay and reservation only when no action remains", () => {
    expect(dataGridSource).toContain("if (!cellDetailButtonEnabled.value && !canQuickDownload && !foreignKey) return null;");
    expect(dataGridSource).toContain("canvasDataGridActionOverlayWidth(canQuickDownload, !!foreignKey, cellDetailButtonEnabled.value)");
    expect(dataGridSource).toContain("canvasDataGridActionOverlayWidth(cell.canQuickDownload, !!cell.foreignKey, cellDetailButtonEnabled.value)");
    expect(dataGridSource).toContain("canvasDataGridActionReservedWidth(cell.canQuickDownload, !!cell.foreignKey, cellDetailButtonEnabled.value)");
    expect(dataGridSource).toMatch(/watch\([\s\S]*?cellDetailButtonEnabled,[\s\S]*?scheduleCanvasDraw/);
  });

  it("keeps context-menu details and refresh restoration independent of the hover setting", () => {
    expect(dataGridSource).toContain("cellDetails: openContextCellDetailDialog");
    expect(dataGridSource).toContain("if (cellDialog) openCellDetailDialog(cellDialog.rowIndex, cellDialog.col);");
  });

  it("resynchronizes the open detail after a mouse selection gesture finishes", () => {
    expect(dataGridSource).toContain("watch([selectedRange, showCellDetail, isEditingDetail, isSelectingCells]");
    expect(dataGridSource).toContain("if (isSelectingCells.value) return;");
    expect(dataGridSource).toMatch(/detailCell\.value = target;\s+hydrateCellDetailTarget\(target\);/);
  });

  it("hydrates bounded large-value previews for every cell detail target", () => {
    expect(dataGridSource).toMatch(/function hydrateCellDetailTarget[\s\S]*?isLargeValuePreview[\s\S]*?hydrateLargeValueCell/);
    expect(dataGridSource).toMatch(/showCellDetails[\s\S]*?hydrateCellDetailTarget\(detailCell\.value\)/);
    expect(dataGridSource).toMatch(/openCellDetailDialog[\s\S]*?hydrateCellDetailTarget\(cellDetailDialogTarget\.value\)/);
  });
});
