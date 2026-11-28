import { describe, expect, it } from "vitest";
import { TAB_DRAG_AUTO_SCROLL_EDGE, TAB_DRAG_AUTO_SCROLL_MAX_STEP, tabDragAutoScrollStep } from "@/lib/tabs/tabDragAutoScroll";

describe("tabDragAutoScrollStep", () => {
  // A 600px wide strip from 100 to 700 with the default 48px edge zones.
  it.each([
    { name: "middle of the strip", position: 400, expected: 0 },
    { name: "just outside the start zone", position: 100 + TAB_DRAG_AUTO_SCROLL_EDGE, expected: 0 },
    { name: "just outside the end zone", position: 700 - TAB_DRAG_AUTO_SCROLL_EDGE, expected: 0 },
    { name: "at the start edge", position: 100, expected: -TAB_DRAG_AUTO_SCROLL_MAX_STEP },
    { name: "at the end edge", position: 700, expected: TAB_DRAG_AUTO_SCROLL_MAX_STEP },
    { name: "past the start edge", position: 20, expected: -TAB_DRAG_AUTO_SCROLL_MAX_STEP },
    { name: "past the end edge", position: 900, expected: TAB_DRAG_AUTO_SCROLL_MAX_STEP },
  ])("returns $expected for $name", ({ position, expected }) => {
    expect(tabDragAutoScrollStep(position, 100, 700)).toBe(expected);
  });

  it("ramps the speed up towards the edge and moves in the matching direction", () => {
    const nearStart = tabDragAutoScrollStep(100 + 40, 100, 700);
    const closerToStart = tabDragAutoScrollStep(100 + 10, 100, 700);
    expect(nearStart).toBeLessThan(0);
    expect(closerToStart).toBeLessThan(nearStart);
    const nearEnd = tabDragAutoScrollStep(700 - 40, 100, 700);
    const closerToEnd = tabDragAutoScrollStep(700 - 10, 100, 700);
    expect(nearEnd).toBeGreaterThan(0);
    expect(closerToEnd).toBeGreaterThan(nearEnd);
  });

  it("shrinks the edge zones on a short strip so they never overlap", () => {
    // 60px strip: each zone is 20px, so the middle 20px stays still.
    expect(tabDragAutoScrollStep(130, 100, 160)).toBe(0);
    expect(tabDragAutoScrollStep(105, 100, 160)).toBeLessThan(0);
    expect(tabDragAutoScrollStep(155, 100, 160)).toBeGreaterThan(0);
    expect(tabDragAutoScrollStep(100, 100, 100)).toBe(0);
  });
});
