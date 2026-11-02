// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_DATA_GRID_ROW_HEIGHT, MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT, canvasDataGridContentHeight, canvasDataGridDomScrollTop, canvasDataGridVirtualScrollTop, drawCanvasDataGrid, type DrawCanvasDataGridOptions } from "@/lib/dataGrid/canvasDataGridRenderer";

function createMockCanvas(width = 800, height = 400) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.fontFamily = "sans-serif";
  canvas.style.fontSize = "13px";
  canvas.style.fontWeight = "400";
  canvas.style.lineHeight = "normal";

  const mockCtx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "measureText") return () => ({ width: 0 });
        if (key === "setTransform" || key === "clearRect" || key === "fillRect" || key === "beginPath" || key === "moveTo" || key === "lineTo" || key === "stroke" || key === "rect" || key === "strokeRect") {
          return () => {};
        }
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;

  vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx);
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

describe("canvasDataGrid max scroll height scaling (#12985)", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      fontFamily: "sans-serif",
      fontSize: "13px",
      fontWeight: "400",
      lineHeight: "normal",
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration);
  });
  it("caps DOM content height at MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT for massive row counts", () => {
    // Normal size: 1:1 rowHeight * rowCount
    expect(canvasDataGridContentHeight(100)).toBe(100 * CANVAS_DATA_GRID_ROW_HEIGHT);
    expect(canvasDataGridContentHeight(10_000)).toBe(260_000);

    // Issue #12985: 1,847,762 rows * 26 = 48,041,812px exceeds browser layout unit limits (2^25 = 33,554,432px).
    // It must be capped at MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT (16,000,000px).
    const massiveRows = 1_847_762;
    expect(massiveRows * CANVAS_DATA_GRID_ROW_HEIGHT).toBe(48_041_812);
    expect(canvasDataGridContentHeight(massiveRows)).toBe(MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT);
    expect(MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT).toBeLessThan(33_554_432);
  });

  it("maps scrollTop 1:1 when below the max scroll height limit", () => {
    const rowCount = 1_000;
    const viewportHeight = 400;

    // Inside bounds: virtualScrollTop matches DOM scrollTop exactly
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 0, rowCount, viewportHeight })).toBe(0);
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 500, rowCount, viewportHeight })).toBe(500);
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 25_600, rowCount, viewportHeight })).toBe(25_600);

    // DOM scroll top matches virtual scroll top exactly
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 0, rowCount, viewportHeight })).toBe(0);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 500, rowCount, viewportHeight })).toBe(500);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 25_600, rowCount, viewportHeight })).toBe(25_600);
  });

  it("scales scrollTop proportionally across the full dataset when row count exceeds max scroll height", () => {
    const rowCount = 1_847_762;
    const viewportHeight = 1_000;
    const virtualHeight = rowCount * CANVAS_DATA_GRID_ROW_HEIGHT; // 48,041,812
    const maxDomScrollTop = MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT - viewportHeight; // 15,999,000
    const maxVirtualScrollTop = virtualHeight - viewportHeight; // 48,040,812

    // At the very top (first row)
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 0, rowCount, viewportHeight })).toBe(0);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 0, rowCount, viewportHeight })).toBe(0);

    // At the very bottom (last row): must reach maxVirtualScrollTop so the final row is visible
    expect(canvasDataGridVirtualScrollTop({ scrollTop: maxDomScrollTop, rowCount, viewportHeight })).toBe(maxVirtualScrollTop);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: maxVirtualScrollTop, rowCount, viewportHeight })).toBe(maxDomScrollTop);

    // At midpoint
    const midDomScroll = maxDomScrollTop / 2;
    const midVirtualScroll = canvasDataGridVirtualScrollTop({ scrollTop: midDomScroll, rowCount, viewportHeight });
    expect(midVirtualScroll).toBeCloseTo(maxVirtualScrollTop / 2, 0);

    // Roundtrip consistency
    const roundtrip = canvasDataGridDomScrollTop({ virtualScrollTop: midVirtualScroll, rowCount, viewportHeight });
    expect(roundtrip).toBeCloseTo(midDomScroll, 0);
  });

  it("handles empty and single-row tables without division by zero", () => {
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 0, rowCount: 0, viewportHeight: 500 })).toBe(0);
    expect(canvasDataGridVirtualScrollTop({ scrollTop: 100, rowCount: 1, viewportHeight: 500 })).toBe(0);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 0, rowCount: 0, viewportHeight: 500 })).toBe(0);
    expect(canvasDataGridDomScrollTop({ virtualScrollTop: 100, rowCount: 1, viewportHeight: 500 })).toBe(0);
  });

  it("draws the last row of a massive 1.8M-row dataset when virtualScrollTop is at the end", () => {
    const rowCount = 1_847_762;
    const viewportWidth = 800;
    const viewportHeight = 500;
    const virtualHeight = rowCount * CANVAS_DATA_GRID_ROW_HEIGHT;
    const maxVirtualScrollTop = virtualHeight - viewportHeight;

    const requestedRows: number[] = [];
    const options: DrawCanvasDataGridOptions = {
      canvas: createMockCanvas(viewportWidth, viewportHeight),
      scroller: createMockScroller(0, MAX_CANVAS_DATA_GRID_SCROLL_HEIGHT - viewportHeight, viewportWidth, viewportHeight),
      width: viewportWidth,
      height: viewportHeight,
      virtualScrollTop: maxVirtualScrollTop,
      isDark: false,
      rowCount,
      rowAt: (index) => {
        requestedRows.push(index);
        return {
          id: index,
          displayIndex: index,
          data: [`row-${index}`],
          isNew: false,
          isDeleted: false,
          isDirtyCol: [false],
          status: "clean",
        };
      },
      renderedColumnWidths: [400],
      renderedColumnOffsets: [0, 400],
      visibleColumnIndexes: [0],
      rowNumberWidth: 80,
      hoverCell: null,
      isScrolling: false,
      editingCell: null,
      searchMatchKeys: new Set(),
      currentSearchMatch: null,
      formatCell: (val) => String(val),
      isRowActive: () => false,
      rowCellsUseSelectionVisual: () => false,
      cellIsSelected: () => false,
      cellCanHover: () => false,
      infiniteScrollEnabled: false,
      pageOffset: 0,
      flatteningMultiLineEnabled: false,
    };

    const drawn = drawCanvasDataGrid(options);
    expect(drawn).toBe(true);

    // The very last row (index 1,847,761) must have been rendered!
    expect(requestedRows).toContain(rowCount - 1);
    expect(Math.max(...requestedRows)).toBe(rowCount - 1);
  });
});
