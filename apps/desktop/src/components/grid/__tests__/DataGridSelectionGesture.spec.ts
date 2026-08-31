import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid selection gesture ownership", () => {
  it("stops released gestures before DOM hover or canvas movement extends them", () => {
    expect(source).toContain("function stopReleasedSelectionGesture(event: MouseEvent)");
    expect(source).toContain("if ((event.buttons & 1) !== 0) return false;");
    expect(source).toContain("function onCellMouseenter(rowIndex: number, visibleColIdx: number, actualColIdx: number, event: MouseEvent)");
    expect(source).toContain('@mouseenter="onCellMouseenter(item.displayIndex, col.visibleColIdx, col.actualColIdx, $event)"');

    const canvasMove = source.slice(source.indexOf("function onCanvasMouseMove"), source.indexOf("function onCanvasMouseLeave"));
    expect(canvasMove).toContain("stopReleasedSelectionGesture(event);");
  });

  it("only exposes cell snapshots for selections with a rectangular matrix", () => {
    expect(source).toMatch(/contextCell\.value && hasCellSelection\.value && selectedCellMatrix\.value\s*\n?\s*\?\s*"cells"/);
  });
});
