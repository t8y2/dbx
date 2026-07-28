import { describe, expect, it } from "vitest";
import { sidebarScrollbarGeometry } from "@/lib/sidebar/sidebarScrollbar";

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
});
