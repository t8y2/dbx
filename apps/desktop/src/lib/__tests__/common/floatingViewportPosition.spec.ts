import { describe, expect, it } from "vitest";
import { floatingArrowOffset, floatingCursorPosition, floatingViewportShift } from "@/lib/common/floatingViewportPosition";

describe("floating viewport position", () => {
  it.each([
    { cursor: { x: 400, y: 300 }, side: "right", expected: { x: 412, y: 312 } },
    { cursor: { x: 400, y: 300 }, side: "left", expected: { x: 188, y: 312 } },
    { cursor: { x: 790, y: 590 }, side: "right", expected: { x: 578, y: 538 } },
    { cursor: { x: 2, y: 2 }, side: "left", expected: { x: 14, y: 14 } },
    { cursor: { x: -30, y: -30 }, side: "left", expected: { x: 8, y: 8 } },
    { cursor: { x: 900, y: 700 }, side: "right", expected: { x: 592, y: 552 } },
  ] as const)("follows and flips around $cursor with $side preference", ({ cursor, side, expected }) => {
    expect(floatingCursorPosition(cursor, { width: 200, height: 40 }, { width: 800, height: 600 }, side)).toEqual(expected);
  });

  it("clamps when neither side has enough room, including oversized surfaces", () => {
    expect(floatingCursorPosition({ x: 150, y: 40 }, { width: 284, height: 64 }, { width: 300, height: 80 })).toEqual({ x: 8, y: 8 });
    expect(floatingCursorPosition({ x: 1, y: 1 }, { width: 200, height: 40 }, { width: 4, height: 4 })).toEqual({ x: 2, y: 2 });
  });

  it("moves a floating element inside each viewport edge", () => {
    expect(floatingViewportShift({ left: -24, right: 296, top: 40, bottom: 80 }, { width: 800, height: 600 })).toEqual({ x: 32, y: 0 });
    expect(floatingViewportShift({ left: 600, right: 840, top: 40, bottom: 80 }, { width: 800, height: 600 })).toEqual({ x: -48, y: 0 });
    expect(floatingViewportShift({ left: 40, right: 240, top: -12, bottom: 28 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 20 });
    expect(floatingViewportShift({ left: 40, right: 240, top: 570, bottom: 620 }, { width: 800, height: 600 })).toEqual({ x: 0, y: -28 });
  });

  it("does not move an element that already fits", () => {
    expect(floatingViewportShift({ left: 8, right: 792, top: 8, bottom: 592 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps the arrow pointing at the trigger after shifting the floating element", () => {
    expect(floatingArrowOffset(320, 32)).toBe(128);
    expect(floatingArrowOffset(320, -48)).toBe(208);
    expect(floatingArrowOffset(40, 100)).toBe(8);
    expect(floatingArrowOffset(40, -100)).toBe(32);
  });
});
