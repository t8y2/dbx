import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = dataGridSource.indexOf(start);
  const endIndex = dataGridSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return dataGridSource.slice(startIndex, endIndex);
}

describe("data grid wheel bindings", () => {
  it("routes Canvas and DOM wheel calculations through the shared helper", () => {
    const canvasHandler = sourceBetween("function onCanvasWheel", "function onDomGridWheel");
    const domHandler = sourceBetween("function onDomGridWheel", "function onCanvasMouseMove");

    for (const handler of [canvasHandler, domHandler]) {
      expect(handler).toContain("resolveDataGridWheelScroll({");
      expect(handler).toContain("if (!wheelScroll.moved) return;");
      expect(handler.indexOf("if (!wheelScroll.moved) return;")).toBeLessThan(handler.indexOf("event.preventDefault();"));
      expect(handler).toContain("event.stopPropagation();");
    }
  });

  it("accepts genuine pixel deltaX in the Canvas handler", () => {
    const predicate = sourceBetween("function shouldAccelerateCanvasWheel", "function onCanvasWheel");
    expect(predicate).toContain("if (event.deltaX !== 0) return true;");
  });

  it("keeps wheel handlers bound in both render modes", () => {
    expect(dataGridSource).toContain('@wheel="onCanvasWheel"');
    expect(dataGridSource.match(/@wheel="onDomGridWheel"/g)).toHaveLength(2);
  });
});
