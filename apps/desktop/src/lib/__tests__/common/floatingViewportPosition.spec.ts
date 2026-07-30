import { describe, expect, it } from "vitest";
import { floatingArrowOffset, floatingViewportShift } from "@/lib/common/floatingViewportPosition";

describe("floating viewport position", () => {
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
