import { describe, expect, it } from "vitest";
import { clampGridPos, collides, columnWidthPx, compactLayout, defaultGridPos, gridContainerHeightPx, gridRectToPixels, pixelDeltaToGridUnits, resolveGridLayout } from "../dataViewGridLayout";

describe("collides", () => {
  it("detects overlapping rects", () => {
    expect(collides({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 })).toBe(true);
  });

  it("returns false for rects that only touch edges", () => {
    expect(collides({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
    expect(collides({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 })).toBe(false);
  });

  it("returns false for rects far apart", () => {
    expect(collides({ x: 0, y: 0, w: 4, h: 4 }, { x: 8, y: 8, w: 4, h: 4 })).toBe(false);
  });
});

describe("compactLayout", () => {
  it("keeps non-overlapping panels in place", () => {
    const entries = [
      { id: "a", gridPos: { x: 0, y: 0, w: 6, h: 4 } },
      { id: "b", gridPos: { x: 6, y: 0, w: 6, h: 4 } },
    ];
    const result = compactLayout(entries);
    expect(result.get("a")).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(result.get("b")).toEqual({ x: 6, y: 0, w: 6, h: 4 });
  });

  it("pushes a later overlapping panel down", () => {
    const entries = [
      { id: "a", gridPos: { x: 0, y: 0, w: 12, h: 4 } },
      { id: "b", gridPos: { x: 0, y: 0, w: 12, h: 4 } },
    ];
    const result = compactLayout(entries);
    expect(result.get("a")).toEqual({ x: 0, y: 0, w: 12, h: 4 });
    expect(result.get("b")).toEqual({ x: 0, y: 4, w: 12, h: 4 });
  });

  it("treats obstacles as fixed and never moves or returns them", () => {
    const entries = [{ id: "a", gridPos: { x: 0, y: 0, w: 12, h: 4 } }];
    const obstacle = { x: 0, y: 0, w: 12, h: 4 };
    const result = compactLayout(entries, [obstacle]);
    expect(result.get("a")).toEqual({ x: 0, y: 4, w: 12, h: 4 });
    expect(result.size).toBe(1);
  });
});

describe("defaultGridPos", () => {
  it("stacks full-width panels by order index", () => {
    expect(defaultGridPos(0)).toEqual({ x: 0, y: 0, w: 12, h: 8 });
    expect(defaultGridPos(1)).toEqual({ x: 0, y: 8, w: 12, h: 8 });
  });
});

describe("resolveGridLayout", () => {
  it("produces stacked full-width defaults when no query has gridPos", () => {
    const result = resolveGridLayout([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(result.get("a")).toEqual({ x: 0, y: 0, w: 12, h: 8 });
    expect(result.get("b")).toEqual({ x: 0, y: 8, w: 12, h: 8 });
    expect(result.get("c")).toEqual({ x: 0, y: 16, w: 12, h: 8 });
  });

  it("keeps persisted layout when it doesn't overlap", () => {
    const result = resolveGridLayout([
      { id: "a", gridPos: { x: 0, y: 0, w: 6, h: 4 } },
      { id: "b", gridPos: { x: 6, y: 0, w: 6, h: 4 } },
    ]);
    expect(result.get("a")).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(result.get("b")).toEqual({ x: 6, y: 0, w: 6, h: 4 });
  });

  it("compacts mixed persisted+missing layouts without overlap", () => {
    const result = resolveGridLayout([
      { id: "a", gridPos: { x: 0, y: 0, w: 12, h: 4 } },
      { id: "b" }, // falls back to defaultGridPos(1) = {x:0,y:8,w:12,h:8}, no overlap
      { id: "c", gridPos: { x: 0, y: 0, w: 12, h: 4 } }, // overlaps "a", must be pushed down
    ]);
    const positions = [...result.values()];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(collides(positions[i], positions[j])).toBe(false);
      }
    }
  });
});

describe("clampGridPos", () => {
  it("enforces minimum size and keeps the panel within the 12-column bounds", () => {
    expect(clampGridPos({ x: -5, y: -1, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 3, h: 4 });
    expect(clampGridPos({ x: 11, y: 0, w: 12, h: 4 })).toEqual({ x: 0, y: 0, w: 12, h: 4 });
  });
});

describe("pixel/grid conversions", () => {
  it("computes column width from container width", () => {
    // (1200 - 11*8) / 12 = (1200-88)/12 = 92.666...
    expect(columnWidthPx(1200)).toBeCloseTo(92.6667, 3);
  });

  it("converts a grid rect to pixels", () => {
    const rect = gridRectToPixels({ x: 1, y: 1, w: 2, h: 2 }, 100);
    expect(rect).toEqual({ left: 108, top: 38, width: 208, height: 68 });
  });

  it("rounds pixel deltas to the nearest grid unit", () => {
    expect(pixelDeltaToGridUnits(50, 20, 100)).toEqual({ dx: 0, dy: 1 });
    expect(pixelDeltaToGridUnits(160, 0, 100)).toEqual({ dx: 1, dy: 0 });
  });

  it("computes the container height needed for the tallest panel", () => {
    expect(
      gridContainerHeightPx([
        { x: 0, y: 0, w: 12, h: 4 },
        { x: 0, y: 4, w: 12, h: 8 },
      ]),
    ).toBe(12 * (30 + 8));
  });
});
