import { describe, expect, it } from "vitest";
import { TAB_DRAG_PREVIEW_HEIGHT, TAB_DRAG_PREVIEW_WIDTH, TAB_WINDOW_PREVIEW_HEIGHT, TAB_WINDOW_PREVIEW_WIDTH, pointOutsideRect, tabDragPreviewRect, tabWindowPreviewRect } from "@/lib/tabs/tabWindowPreview";

describe("tabWindowPreviewRect", () => {
  it("keeps the final window aspect ratio inside the source viewport", () => {
    const preview = tabWindowPreviewRect({ x: 900, y: 500 }, { width: 1000, height: 700 });

    expect(preview.width / preview.height).toBeCloseTo(TAB_WINDOW_PREVIEW_WIDTH / TAB_WINDOW_PREVIEW_HEIGHT);
    expect(preview.left).toBeGreaterThanOrEqual(12);
    expect(preview.top).toBeGreaterThanOrEqual(12);
    expect(preview.left + preview.width).toBeLessThanOrEqual(988);
    expect(preview.top + preview.height).toBeLessThanOrEqual(688);
  });

  it("allows a small movement tolerance around the tab bar", () => {
    const tabBar = { left: 0, top: 0, right: 1000, bottom: 40 };

    expect(pointOutsideRect({ x: 500, y: 47 }, tabBar, 8)).toBe(false);
    expect(pointOutsideRect({ x: 500, y: 49 }, tabBar, 8)).toBe(true);
  });

  it("uses a compact tab chip for the drag indicator", () => {
    const preview = tabDragPreviewRect({ x: 500, y: 100 }, { width: 1000, height: 700 });

    expect(preview.width).toBe(TAB_DRAG_PREVIEW_WIDTH);
    expect(preview.height).toBe(TAB_DRAG_PREVIEW_HEIGHT);
    expect(preview.left).toBeLessThan(500);
    expect(preview.top).toBeLessThan(100);
  });
});
