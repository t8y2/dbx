import { describe, expect, it } from "vitest";
import { clipToCard } from "../diagramGeometry";

describe("clipToCard", () => {
  const half = { width: 100, height: 50 };

  it("exits through the vertical edge for a horizontal run", () => {
    // Centre (0,0) to (500,0): the line leaves through the right edge at
    // x = +100, not through the top or bottom.
    expect(clipToCard({ x: 0, y: 0 }, { x: 500, y: 0 }, half)).toEqual({ x: 100, y: 0 });
  });

  it("exits through the horizontal edge for a vertical run", () => {
    expect(clipToCard({ x: 0, y: 0 }, { x: 0, y: 500 }, half)).toEqual({ x: 0, y: 50 });
  });

  it("picks the nearer edge on a diagonal", () => {
    // Slope 1 against a 2:1 card: the vertical edge is reached first, so the
    // result sits ON x = 100 with |y| < 50. Clipping to the wrong axis puts
    // the endpoint outside the card and the line visibly overshoots.
    const point = clipToCard({ x: 0, y: 0 }, { x: 500, y: 500 }, half);
    expect(point.x).toBeCloseTo(50);
    expect(point.y).toBeCloseTo(50);
  });

  it("returns the centre when both points coincide", () => {
    // Two tables laid out at the same position would otherwise divide by zero
    // and emit NaN into the SVG path, which renders nothing at all.
    expect(clipToCard({ x: 7, y: 7 }, { x: 7, y: 7 }, half)).toEqual({ x: 7, y: 7 });
  });

  it("handles negative directions symmetrically", () => {
    expect(clipToCard({ x: 0, y: 0 }, { x: -500, y: 0 }, half)).toEqual({ x: -100, y: 0 });
  });
});
