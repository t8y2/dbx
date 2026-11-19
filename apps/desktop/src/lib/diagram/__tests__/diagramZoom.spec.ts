import { describe, expect, it } from "vitest";
import { DIAGRAM_MIN_ZOOM, DIAGRAM_MAX_ZOOM, clampDiagramZoom, diagramViewportAtZoom, normalizeDiagramWheelDelta, zoomFromGestureScale, zoomFromWheelDelta } from "../diagramZoom";

describe("diagram gestures", () => {
  it("accumulates fractional trackpad deltas in both directions without rounding them away", () => {
    let zoom = 0.5;
    for (let i = 0; i < 100; i++) zoom = zoomFromWheelDelta(zoom, -0.1);
    expect(zoom).toBeCloseTo(0.5 * Math.exp(0.03), 12);
    expect(zoom).toBeGreaterThan(0.5);
    for (let i = 0; i < 100; i++) zoom = zoomFromWheelDelta(zoom, 0.1);
    expect(zoom).toBeCloseTo(0.5, 12);
  });

  it("shares zoom bounds across wheel and pinch", () => {
    expect(DIAGRAM_MIN_ZOOM).toBe(0.05);
    expect(DIAGRAM_MAX_ZOOM).toBe(2);
    expect(zoomFromWheelDelta(1, -100)).toBeGreaterThan(1);
    expect(zoomFromWheelDelta(1, 100)).toBeLessThan(1);
    expect(zoomFromWheelDelta(1, 100000)).toBe(DIAGRAM_MIN_ZOOM);
    expect(zoomFromWheelDelta(1, -100000)).toBe(DIAGRAM_MAX_ZOOM);
    expect(zoomFromGestureScale(1, 100)).toBe(DIAGRAM_MAX_ZOOM);
    expect(zoomFromGestureScale(1, 0.001)).toBe(DIAGRAM_MIN_ZOOM);
    expect(clampDiagramZoom(0.05)).toBe(0.05);
  });

  it.each([0, NaN, Infinity, -Infinity])("ignores zero/non-finite wheel delta %s", (delta) => {
    expect(zoomFromWheelDelta(0.745, delta)).toBe(0.745);
  });

  it("normalizes pixel, line, and page scrolling", () => {
    expect(normalizeDiagramWheelDelta(2, 0, 600)).toBe(2);
    expect(normalizeDiagramWheelDelta(2, 1, 600)).toBe(32);
    expect(normalizeDiagramWheelDelta(2, 2, 600)).toBe(1200);
    expect(normalizeDiagramWheelDelta(NaN, 0, 600)).toBe(0);
  });

  it.each([0.05, 0.7, 2])("keeps the world point at the cursor when zoom changes to %s", (zoom) => {
    const original = { x: -140, y: 90, zoom: 0.8 };
    const pointer = { x: 300, y: 200 };
    const next = diagramViewportAtZoom(original, pointer, zoom);
    expect((pointer.x - next.x) / next.zoom).toBeCloseTo((pointer.x - original.x) / original.zoom);
    expect((pointer.y - next.y) / next.zoom).toBeCloseTo((pointer.y - original.y) / original.zoom);
  });
});
