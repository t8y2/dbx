// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasDataGridActionOverlayWidth, canvasDataGridActionReservedWidth, drawCanvasDataGrid, resolveCanvasBackingStoreMetrics, resolveCanvasDataGridPixelRatio, type DrawCanvasDataGridOptions } from "@/lib/dataGrid/canvasDataGridRenderer";

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
    pageOffset: 0,
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

  it.each([
    [false, false, true, 22, 28],
    [false, false, false, 0, 0],
    [true, false, false, 22, 28],
    [false, true, false, 22, 28],
    [true, true, false, 44, 50],
    [true, true, true, 66, 72],
  ])("reserves only enabled Canvas actions (download=%s, foreign key=%s, detail=%s)", (canQuickDownload, canNavigateForeignKey, showCellDetail, overlayWidth, reservedWidth) => {
    expect(canvasDataGridActionOverlayWidth(canQuickDownload, canNavigateForeignKey, showCellDetail)).toBe(overlayWidth);
    expect(canvasDataGridActionReservedWidth(canQuickDownload, canNavigateForeignKey, showCellDetail)).toBe(reservedWidth);
  });

  it("uses the exact observed device-pixel size instead of a nominal DPR", () => {
    expect(
      resolveCanvasBackingStoreMetrics({
        width: 801,
        height: 399,
        pixelRatio: 1.25,
        devicePixelSize: { cssWidth: 801, cssHeight: 399, pixelWidth: 1001, pixelHeight: 499 },
      }),
    ).toEqual({
      pixelWidth: 1001,
      pixelHeight: 499,
      scaleX: 1001 / 801,
      scaleY: 499 / 399,
      measured: true,
    });
  });

  it.each([
    [1.2, 1.2, 960, 480],
    [1.25, 1.25, 1000, 500],
    [2.4, 1.2, 1920, 960],
    [0.8, 0.8, 800, 400],
    [6, 1.5, 3200, 1600],
  ])("uses Linux's zoom-inclusive DPR %s at UI scale %s without resampling twice", (devicePixelRatio, uiScale, pixelWidth, pixelHeight) => {
    const pixelRatio = resolveCanvasDataGridPixelRatio({ devicePixelRatio, uiScale, platform: "linux" });
    // WebKitGTK lacks devicePixelContentBoxSize, so the nominal fallback must
    // itself produce the correct bitmap dimensions.
    const metrics = resolveCanvasBackingStoreMetrics({ width: 800, height: 400, pixelRatio });
    expect(metrics).toMatchObject({ pixelWidth, pixelHeight, measured: false });
  });

  it.each(["macos", "windows", "unknown"] as const)("preserves existing UI zoom compensation on %s", (platform) => {
    expect(resolveCanvasDataGridPixelRatio({ devicePixelRatio: 2, uiScale: 1.2, platform })).toBe(2.4);
  });

  it("does not allocate an extra pixel for WebKitGTK's floating-point zoom ratio", () => {
    const pixelRatio = resolveCanvasDataGridPixelRatio({ devicePixelRatio: 1.2000000476837158, uiScale: 1.2, platform: "linux" });
    expect(resolveCanvasBackingStoreMetrics({ width: 800, height: 400, pixelRatio })).toEqual({ pixelWidth: 960, pixelHeight: 480, scaleX: 1.2, scaleY: 1.2, measured: false });
  });

  it.each([1, 1.125, 1.1875, 1.2345])("keeps the exact observed density when the nominal ratio is %s", (pixelRatio) => {
    expect(
      resolveCanvasBackingStoreMetrics({
        width: 800,
        height: 400,
        pixelRatio,
        devicePixelSize: { cssWidth: 800, cssHeight: 400, pixelWidth: 1000, pixelHeight: 500 },
      }),
    ).toEqual({ pixelWidth: 1000, pixelHeight: 500, scaleX: 1.25, scaleY: 1.25, measured: true });
  });

  it("ignores a stale observed size after the CSS viewport changes", () => {
    expect(
      resolveCanvasBackingStoreMetrics({
        width: 900,
        height: 400,
        pixelRatio: 1.25,
        devicePixelSize: { cssWidth: 801, cssHeight: 399, pixelWidth: 1001, pixelHeight: 499 },
      }),
    ).toEqual({ pixelWidth: 1125, pixelHeight: 500, scaleX: 1.25, scaleY: 1.25, measured: false });
  });

  it("caps the observed backing store only at the absolute safety limit", () => {
    expect(
      resolveCanvasBackingStoreMetrics({
        width: 801,
        height: 399,
        pixelRatio: 1.125,
        devicePixelSize: { cssWidth: 801, cssHeight: 399, pixelWidth: 4005, pixelHeight: 1995 },
      }),
    ).toEqual({ pixelWidth: 3204, pixelHeight: 1596, scaleX: 4, scaleY: 4, measured: true });
  });

  it("caps a fallback ratio at the absolute safety limit", () => {
    expect(resolveCanvasBackingStoreMetrics({ width: 801, height: 399, pixelRatio: 5 })).toEqual({ pixelWidth: 3204, pixelHeight: 1596, scaleX: 4, scaleY: 4, measured: false });
  });

  it("reports a completed draw only after obtaining a Canvas context", () => {
    const canvas = createMockCanvas();
    const options = createBaseOptions({ canvas, rowCount: 0, rowAt: () => undefined });
    const fillRect = vi.fn();
    vi.spyOn(canvas, "getContext")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(
        new Proxy(
          {},
          {
            get: (_target, key) => (key === "fillRect" ? fillRect : key === "measureText" ? () => ({ width: 0 }) : () => {}),
            set: () => true,
          },
        ) as unknown as CanvasRenderingContext2D,
      );

    expect(drawCanvasDataGrid(options)).toBe(false);
    expect(fillRect).not.toHaveBeenCalled();
    expect(drawCanvasDataGrid(options)).toBe(true);
    expect(fillRect).toHaveBeenCalled();
  });

  it.each([1, 1.2, 1.25, 2])("snaps glyph baselines, including italic NULL and semibold row numbers, at density %s", (pixelRatio) => {
    const canvas = createMockCanvas();
    const painted: { text: string; y: number; font: string; baseline: string }[] = [];
    const state = { font: "", textBaseline: "middle" };
    const offsetForFont = () => (state.font.includes("italic") ? 6.125 : state.font.includes("600") ? 4.75 : 5.25);
    const ctx = new Proxy(state, {
      get: (target, key) => {
        if (key === "measureText") return () => ({ width: 10, actualBoundingBoxAscent: state.textBaseline === "alphabetic" ? 5 + offsetForFont() : 5 });
        if (key === "fillText") return (text: string, _x: number, y: number) => painted.push({ text, y, font: state.font, baseline: state.textBaseline });
        return key in target ? target[key as keyof typeof target] : () => {};
      },
      set: (target, key, value) => Reflect.set(target, key, value),
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx);
    const options = createBaseOptions({
      canvas,
      pixelRatio,
      scroller: createMockScroller(0, 3.5),
      rowCount: 2,
      rowAt: (index) => ({ ...createMockRow(index, index, ["用户名称", null, "1234567890"]), status: index === 1 ? "edited" : "clean" }),
      formatCell: (value) => (value === null ? "NULL" : String(value)),
    });

    expect(drawCanvasDataGrid(options)).toBe(true);
    expect(painted).toHaveLength(8);
    expect(painted.some((call) => call.font.includes("italic"))).toBe(true);
    expect(painted.some((call) => call.font.includes("600"))).toBe(true);
    for (const call of painted) {
      expect(call.baseline).toBe("alphabetic");
      expect(call.y * pixelRatio).toBeCloseTo(Math.round(call.y * pixelRatio));
    }
    // The old middle anchor was already snapped; its 5.25px font offset
    // still put the glyph baseline between device pixels.
    const centerY = Math.round((Math.round(13 * pixelRatio) / pixelRatio - 3.5) * pixelRatio) / pixelRatio;
    expect(painted[0]?.y).toBe(Math.round((centerY + 5.25) * pixelRatio) / pixelRatio);
  });

  it("remeasures baseline offsets after font readiness invalidates the render style", () => {
    const canvas = createMockCanvas();
    const state = { font: "", textBaseline: "middle" };
    let baselineOffset = 5.25;
    const painted: number[] = [];
    const measureText = vi.fn(() => ({ width: 10, actualBoundingBoxAscent: state.textBaseline === "alphabetic" ? 5 + baselineOffset : 5 }));
    const ctx = new Proxy(state, {
      get: (target, key) => {
        if (key === "measureText") return measureText;
        if (key === "fillText") return (_text: string, _x: number, y: number) => painted.push(y);
        return key in target ? target[key as keyof typeof target] : () => {};
      },
      set: (target, key, value) => Reflect.set(target, key, value),
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx);
    const options = createBaseOptions({ canvas, rowCount: 1, styleKey: "font-pending" });
    drawCanvasDataGrid(options);
    expect(painted[0]).toBe(18);
    const measuredBefore = measureText.mock.calls.length;
    painted.length = 0;
    baselineOffset = 6.75;
    drawCanvasDataGrid(options);
    expect(painted[0]).toBe(18);
    expect(measureText.mock.calls.length).toBe(measuredBefore);

    painted.length = 0;
    drawCanvasDataGrid({ ...options, styleKey: "font-ready" });
    expect(painted[0]).toBe(20);
    expect(measureText.mock.calls.length).toBeGreaterThan(measuredBefore);
  });

  it("keeps middle alignment when the engine lacks actual glyph metrics", () => {
    const canvas = createMockCanvas();
    const state = { font: "", textBaseline: "middle" };
    const baselines: string[] = [];
    const ctx = new Proxy(state, {
      get: (target, key) => {
        if (key === "measureText") return () => ({ width: 10 });
        if (key === "fillText") return () => baselines.push(state.textBaseline);
        return key in target ? target[key as keyof typeof target] : () => {};
      },
      set: (target, key, value) => Reflect.set(target, key, value),
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx);
    expect(drawCanvasDataGrid(createBaseOptions({ canvas, rowCount: 1 }))).toBe(true);
    expect(baselines).toEqual(["middle", "middle", "middle", "middle"]);
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

  it("draws with zebraStriping enabled and disabled", () => {
    const canvas = createMockCanvas();
    const optionsWithZebra = createBaseOptions({
      canvas,
      zebraStriping: true,
    });
    expect(() => drawCanvasDataGrid(optionsWithZebra)).not.toThrow();

    const optionsWithoutZebra = createBaseOptions({
      canvas,
      zebraStriping: false,
    });
    expect(() => drawCanvasDataGrid(optionsWithoutZebra)).not.toThrow();

    const optionsWithCustomZebraColor = createBaseOptions({
      canvas,
      zebraStriping: true,
      zebraRowBg: "#334455",
    });
    expect(() => drawCanvasDataGrid(optionsWithCustomZebraColor)).not.toThrow();
  });

  it("draws with duplicate and null highlight keys without error", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const dupKeys = new Set<number>([0, 1]);
    const nullKeys = new Set<number>([2]);

    const options = createBaseOptions({
      canvas,
      duplicateHighlightKeys: dupKeys,
      nullHighlightKeys: nullKeys,
    });
    expect(() => drawCanvasDataGrid(options)).not.toThrow();
  });

  it("draws with custom crosshair row and column colors", () => {
    const canvas = createMockCanvas();
    const optionsWithCustomCrosshairColors = createBaseOptions({
      canvas,
      crosshair: {
        rowIndex: 0,
        visibleColIdx: 0,
        rowCrosshair: true,
        columnCrosshair: true,
      },
      crosshairRowBg: "#aec3e0",
      crosshairColBg: "#8eaad2",
    });
    expect(() => drawCanvasDataGrid(optionsWithCustomCrosshairColors)).not.toThrow();
  });
});
