import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { canvasDataGridActionReservedWidth, fitCanvasText, resolveCanvasCellTextLayout, resolveCanvasDataGridRowFill } from "../../apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts";
import { DATA_GRID_DARK_STRIPED_ROW_BG, DATA_GRID_LIGHT_STRIPED_ROW_BG, resolveDataGridPaintTheme } from "../../apps/desktop/src/lib/dataGrid/dataGridPaintTheme.ts";

function measureContext(charWidth = 1): CanvasRenderingContext2D {
  return {
    font: "13px sans-serif",
    measureText: (text: string) => ({ width: text.length * charWidth }),
  } as CanvasRenderingContext2D;
}

test("fitCanvasText keeps text that fits the available cell width", () => {
  const ctx = measureContext();
  const text = "1234567890abcdefghijklmnopqrst";

  assert.equal(fitCanvasText(ctx, text, text.length), text);
});

test("fitCanvasText truncates only when text exceeds the available cell width", () => {
  const ctx = measureContext();

  assert.equal(fitCanvasText(ctx, "1234567890", 8), "12345...");
});

test("fitCanvasText preserves the numeric suffix for right-aligned narrow cells", () => {
  const ctx = measureContext();

  assert.equal(fitCanvasText(ctx, "1234567890", 8, "right"), "...67890");
});

test("canvas text layout reserves hover actions only for right-aligned cells", () => {
  assert.deepEqual(resolveCanvasCellTextLayout({ drawX: 100, colWidth: 80, dpr: 1, isRightAlign: true, reservedWidth: 28 }), {
    textAnchorX: 140,
    maxWidth: 28,
  });
  assert.deepEqual(resolveCanvasCellTextLayout({ drawX: 100, colWidth: 80, dpr: 1, isRightAlign: false, reservedWidth: 28 }), {
    textAnchorX: 112,
    maxWidth: 56,
  });
  assert.equal(canvasDataGridActionReservedWidth(false), 28);
  assert.equal(canvasDataGridActionReservedWidth(true), 50);
});

test("DataGrid forwards hover action reservation only for right-aligned canvas cells", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

  assert.match(source, /columnAligns\.value\[cell\.visibleColIdx\] !== "right"/);
  assert.match(source, /reservedWidth: canvasDataGridActionReservedWidth\(cell\.canQuickDownload\)/);
  assert.match(source, /rightAlignedActionCell: canvasRightAlignedActionCell\.value/);
});

test("canvas row fill keeps frozen and scrolling regions on the same selection surface", () => {
  const theme = { cellActive: "active-blue", cellSelected: "selected-blue" };

  assert.equal(resolveCanvasDataGridRowFill(theme, "base", { isActive: true, isDeleted: false, isSelected: false }), "active-blue");
  assert.equal(resolveCanvasDataGridRowFill(theme, "base", { isActive: true, isDeleted: false, isSelected: true }), "selected-blue");
  assert.equal(resolveCanvasDataGridRowFill(theme, "deleted", { isActive: true, isDeleted: true, isSelected: false }), "deleted");
});

test("data grid paint themes use the increased striped row contrast", () => {
  const getVar = () => "";

  const lightTheme = resolveDataGridPaintTheme({ getVar, isDark: false });
  assert.equal(lightTheme.rowMuted, DATA_GRID_LIGHT_STRIPED_ROW_BG);
  assert.notEqual(lightTheme.rowMuted, lightTheme.rowNew);
  assert.equal(resolveDataGridPaintTheme({ getVar, isDark: true }).rowMuted, DATA_GRID_DARK_STRIPED_ROW_BG);
});

test("data grid paint theme uses the resolved striped row token", () => {
  const getVar = (name: string) => (name === "--data-grid-row-muted-bg" ? "rgb(235, 239, 244)" : "");

  assert.equal(resolveDataGridPaintTheme({ getVar, isDark: false }).rowMuted, "rgb(235, 239, 244)");
});
