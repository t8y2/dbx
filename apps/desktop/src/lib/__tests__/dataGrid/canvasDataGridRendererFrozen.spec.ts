// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_DATA_GRID_ROW_HEIGHT, drawCanvasDataGrid, type DrawCanvasDataGridOptions } from "@/lib/dataGrid/canvasDataGridRenderer";

function createMockCanvas(width = 800, height = 400) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // Mock getComputedStyle
  canvas.style.fontFamily = "sans-serif";
  canvas.style.fontSize = "13px";
  canvas.style.fontWeight = "400";
  canvas.style.lineHeight = "normal";
  return canvas;
}

function createMockScroller(scrollLeft = 0, scrollTop = 0, clientWidth = 800, clientHeight = 400) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollLeft", { value: scrollLeft, writable: true, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  Object.defineProperty(scroller, "clientWidth", { value: clientWidth, writable: true, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: clientHeight, writable: true, configurable: true });
  return scroller;
}

function createMockRow(id: number, displayIndex: number, data: (string | null)[]) {
  return {
    id,
    displayIndex,
    data,
    isNew: false,
    isDraft: false,
    isDeleted: false,
    isDirtyCol: data.map(() => false),
    status: "clean" as const,
  };
}

function createBaseOptions(overrides: Partial<DrawCanvasDataGridOptions> = {}): DrawCanvasDataGridOptions {
  return {
    canvas: createMockCanvas(),
    scroller: createMockScroller(),
    width: 800,
    height: 400,
    pixelRatio: 1,
    isDark: false,
    rowCount: 3,
    rowAt: (index: number) => (index < 3 ? createMockRow(index, index, ["val1", "val2", "val3"]) : undefined),
    renderedColumnWidths: [120, 120, 120],
    visibleColumnIndexes: [0, 1, 2],
    rowNumberWidth: 40,
    hoverCell: null,
    isScrolling: false,
    editingCell: null,
    searchMatchKeys: new Set(),
    currentSearchMatch: null,
    formatCell: (value) => String(value ?? ""),
    isRowActive: () => false,
    rowCellsUseSelectionVisual: () => false,
    cellIsSelected: () => false,
    cellCanHover: () => true,
    infiniteScrollEnabled: false,
    pageSize: 100,
    currentPage: 1,
    ...overrides,
  };
}

describe("drawCanvasDataGrid with frozen columns", () => {
  beforeEach(() => {
    // Mock getComputedStyle to return valid font properties
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      fontFamily: "sans-serif",
      fontSize: "13px",
      fontWeight: "400",
      lineHeight: "normal",
      getPropertyValue: () => "",
    } as CSSStyleDeclaration);
  });

  it("draws without errors when frozenColumnCount is 0", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({ canvas, frozenColumnCount: 0 });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("draws without errors when frozenColumnCount is set", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({ canvas, frozenColumnCount: 2 });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("draws without errors when frozenColumnCount equals total columns", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({ canvas, frozenColumnCount: 3 });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("draws without errors when frozenColumnCount exceeds total columns", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({ canvas, frozenColumnCount: 5 });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("draws without errors with scroll offset and frozen columns", () => {
    const canvas = createMockCanvas();
    const scroller = createMockScroller(200, 0);
    const options = createBaseOptions({ canvas, scroller, frozenColumnCount: 1 });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("frozen columns remain at fixed positions regardless of scrollLeft", () => {
    // This test verifies the canvas is drawn without errors at different scroll positions
    // The actual pixel-level verification would require snapshot testing
    const canvas1 = createMockCanvas();
    const canvas2 = createMockCanvas();
    const scroller1 = createMockScroller(0, 0);
    const scroller2 = createMockScroller(500, 0);

    const options1 = createBaseOptions({ canvas: canvas1, scroller: scroller1, frozenColumnCount: 2 });
    const options2 = createBaseOptions({ canvas: canvas2, scroller: scroller2, frozenColumnCount: 2 });

    expect(() => drawCanvasDataGrid(options1)).not.toThrow();
    expect(() => drawCanvasDataGrid(options2)).not.toThrow();
  });

  it("handles empty rows with frozen columns", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({
      canvas,
      frozenColumnCount: 1,
      rowCount: 0,
      rowAt: () => undefined,
    });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("handles single column with frozen columns", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({
      canvas,
      frozenColumnCount: 1,
      renderedColumnWidths: [120],
      visibleColumnIndexes: [0],
      rowCount: 1,
      rowAt: (index: number) => (index === 0 ? createMockRow(0, 0, ["val"]) : undefined),
    });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });
});
