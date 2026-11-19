import { describe, expect, it } from "vitest";
import { sidebarHorizontalWheelDelta, sidebarScrollbarGeometry } from "@/lib/sidebar/sidebarScrollbar";

describe("sidebarScrollbarGeometry", () => {
  it("returns no thumb when content fits the viewport", () => {
    expect(sidebarScrollbarGeometry({ scrollOffset: 0, viewportSize: 300, contentSize: 300, trackSize: 300 })).toEqual({
      thumbOffset: 0,
      thumbSize: 0,
      maxThumbOffset: 0,
      maxScrollOffset: 0,
    });
  });

  it("maps horizontal content scrolling onto the draggable track", () => {
    expect(sidebarScrollbarGeometry({ scrollOffset: 150, viewportSize: 300, contentSize: 600, trackSize: 300 })).toEqual({
      thumbOffset: 75,
      thumbSize: 150,
      maxThumbOffset: 150,
      maxScrollOffset: 300,
    });
  });

  it("keeps the thumb usable for very wide content and clamps its position", () => {
    expect(sidebarScrollbarGeometry({ scrollOffset: 10_000, viewportSize: 200, contentSize: 10_000, trackSize: 200 })).toEqual({
      thumbOffset: 176,
      thumbSize: 24,
      maxThumbOffset: 176,
      maxScrollOffset: 9_800,
    });
  });

  it("maps Shift+wheel movement onto horizontal scrolling", () => {
    expect(sidebarHorizontalWheelDelta({ enabled: true, shiftKey: true, deltaX: 0, deltaY: 40, scrollLeft: 10, clientWidth: 100, scrollWidth: 300 })).toBe(40);
    expect(sidebarHorizontalWheelDelta({ enabled: true, shiftKey: true, deltaX: -20, deltaY: 40, scrollLeft: 100, clientWidth: 100, scrollWidth: 300 })).toBe(-20);
  });

  it("normalizes line and page wheel units and clamps the final movement", () => {
    const options = { enabled: true, shiftKey: true, deltaX: 0, deltaY: 2, scrollLeft: 0, clientWidth: 100, scrollWidth: 500 };
    expect(sidebarHorizontalWheelDelta({ ...options, deltaMode: 1, lineHeight: 28 })).toBe(56);
    expect(sidebarHorizontalWheelDelta({ ...options, deltaMode: 2 })).toBe(200);
    expect(sidebarHorizontalWheelDelta({ ...options, scrollLeft: 390, deltaY: 50 })).toBe(10);
    expect(sidebarHorizontalWheelDelta({ ...options, deltaY: -50 })).toBe(0);
    expect(sidebarHorizontalWheelDelta({ ...options, scrollWidth: 100 })).toBe(0);
  });

  it("does not consume disabled or boundary wheel gestures", () => {
    expect(sidebarHorizontalWheelDelta({ enabled: false, shiftKey: true, deltaX: 0, deltaY: 40, scrollLeft: 10, clientWidth: 100, scrollWidth: 300 })).toBe(0);
    expect(sidebarHorizontalWheelDelta({ enabled: true, shiftKey: false, deltaX: 0, deltaY: 40, scrollLeft: 10, clientWidth: 100, scrollWidth: 300 })).toBe(0);
    expect(sidebarHorizontalWheelDelta({ enabled: true, shiftKey: true, deltaX: 0, deltaY: 40, scrollLeft: 200, clientWidth: 100, scrollWidth: 300 })).toBe(0);
  });
});
