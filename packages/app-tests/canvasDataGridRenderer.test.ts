import { strict as assert } from "node:assert";
import { test } from "vitest";
import { fitCanvasText } from "../../apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts";
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
