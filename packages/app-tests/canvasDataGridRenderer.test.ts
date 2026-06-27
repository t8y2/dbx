import { strict as assert } from "node:assert";
import { test } from "vitest";
import { fitCanvasText } from "../../apps/desktop/src/lib/canvasDataGridRenderer.ts";

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
