import { describe, expect, it } from "vitest";
import { buildSubmenuGraceArea, isPointInPolygon, isPointerInGraceArea } from "../pointerGraceArea";

describe("isPointInPolygon", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("rejects anything that cannot bound an area", () => {
    expect(isPointInPolygon({ x: 5, y: 5 }, [])).toBe(false);
    expect(isPointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }])).toBe(false);
    expect(
      isPointInPolygon({ x: 5, y: 5 }, [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(false);
  });

  it("separates inside from outside points", () => {
    expect(isPointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(isPointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
    expect(isPointInPolygon({ x: 11, y: 5 }, square)).toBe(false);
    expect(isPointInPolygon({ x: 5, y: -1 }, square)).toBe(false);
    expect(isPointInPolygon({ x: 5, y: 11 }, square)).toBe(false);
  });

  it("handles a non-convex outline", () => {
    // An L: the 0..10 square with its top-right quadrant removed, so the
    // bounding box contains points the outline does not.
    const lShape = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isPointInPolygon({ x: 2, y: 2 }, lShape)).toBe(true);
    expect(isPointInPolygon({ x: 8, y: 2 }, lShape)).toBe(true);
    expect(isPointInPolygon({ x: 2, y: 8 }, lShape)).toBe(true);
    // Inside the bounding box but in the removed quadrant.
    expect(isPointInPolygon({ x: 8, y: 8 }, lShape)).toBe(false);
  });
});

describe("isPointerInGraceArea", () => {
  it("treats a missing area as no match", () => {
    expect(isPointerInGraceArea({ x: 1, y: 1 }, null)).toBe(false);
    expect(isPointerInGraceArea({ x: 1, y: 1 }, undefined)).toBe(false);
  });

  it("delegates to the polygon test", () => {
    const area = buildSubmenuGraceArea({ origin: { x: 0, y: 5 }, nearEdgeX: 10, top: 0, bottom: 10 });
    expect(isPointerInGraceArea({ x: 5, y: 5 }, area)).toBe(true);
    expect(isPointerInGraceArea({ x: 50, y: 5 }, area)).toBe(false);
  });
});

describe("buildSubmenuGraceArea", () => {
  it("fans out from the departure point across the submenu edge", () => {
    const area = buildSubmenuGraceArea({ origin: { x: 0, y: 5 }, nearEdgeX: 10, top: 0, bottom: 10 });
    // The path right after leaving the trigger stays inside.
    expect(isPointerInGraceArea({ x: 1, y: 5 }, area)).toBe(true);
    // Both corners of the submenu edge are reachable, which is what survives a
    // diagonal move: the wedge spans the whole edge, not just the departure row.
    expect(isPointerInGraceArea({ x: 9, y: 1 }, area)).toBe(true);
    expect(isPointerInGraceArea({ x: 9, y: 9 }, area)).toBe(true);
    // Outside the triangle: past the submenu edge, and behind the origin. The
    // submenu's own rectangle is covered by the hover check instead.
    expect(isPointerInGraceArea({ x: 11, y: 5 }, area)).toBe(false);
    expect(isPointerInGraceArea({ x: -1, y: 5 }, area)).toBe(false);
  });

  it("points leftwards when the submenu sits left of the pointer", () => {
    const area = buildSubmenuGraceArea({ origin: { x: 60, y: 5 }, nearEdgeX: 50, top: 0, bottom: 10 });
    expect(isPointerInGraceArea({ x: 55, y: 5 }, area)).toBe(true);
    expect(isPointerInGraceArea({ x: 65, y: 5 }, area)).toBe(false);
  });

  it("only admits movement converging on the submenu when the pointer left far above it", () => {
    const area = buildSubmenuGraceArea({ origin: { x: 0, y: -40 }, nearEdgeX: 10, top: 0, bottom: 10 });
    // Sliding down towards the submenu's edge is admitted...
    expect(isPointerInGraceArea({ x: 7, y: -8 }, area)).toBe(true);
    // ...while moving further away, or drifting sideways, is not.
    expect(isPointerInGraceArea({ x: 7, y: -20 }, area)).toBe(false);
    expect(isPointerInGraceArea({ x: 6, y: -8 }, area)).toBe(false);
  });

  it("keeps the base pinned to the submenu edge", () => {
    const area = buildSubmenuGraceArea({ origin: { x: 3, y: 4 }, nearEdgeX: 12, top: 2, bottom: 8 });
    expect(area).toEqual([
      { x: 3, y: 4 },
      { x: 12, y: 2 },
      { x: 12, y: 8 },
    ]);
  });
});
