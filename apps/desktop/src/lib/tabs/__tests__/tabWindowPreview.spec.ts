import { describe, expect, it } from "vitest";
import { TAB_DRAG_PREVIEW_HEIGHT, TAB_DRAG_PREVIEW_WIDTH, TAB_WINDOW_PREVIEW_HEIGHT, TAB_WINDOW_PREVIEW_WIDTH, pointOutsideRect, tabDragPreviewRect, tabWindowPreviewRect, tabWindowBoundsInWorkArea } from "@/lib/tabs/tabWindowPreview";

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

describe("detached window work area", () => {
  const retina = {
    scaleFactor: 2,
    position: { x: 0, y: 0 },
    size: { width: 3024, height: 1964 },
    workArea: { position: { x: 0, y: 48 }, size: { width: 3024, height: 1800 } },
  };

  it("keeps the entire window inside a Retina work area after a bottom-right drop", () => {
    expect(tabWindowBoundsInWorkArea({ x: 1490, y: 900 }, retina)).toEqual({ x: 300, y: 112, width: 1200, height: 800, minWidth: 900, minHeight: 600 });
  });

  it("clamps a top-left drop using a secondary monitor's negative origin and its own scale", () => {
    const monitor = { scaleFactor: 1, position: { x: -1920, y: -1080 }, size: { width: 1920, height: 1080 } };
    expect(tabWindowBoundsInWorkArea({ x: -2500, y: -1500 }, monitor)).toMatchObject({ x: -1908, y: -1068, width: 1200, height: 800 });
    expect(tabWindowBoundsInWorkArea({ x: -10, y: -10 }, monitor)).toMatchObject({ x: -1212, y: -812 });
  });

  it("shrinks the default size and minimum size to fit a small work area", () => {
    const bounds = tabWindowBoundsInWorkArea({ x: 5000, y: 5000 }, { scaleFactor: 2, position: { x: 0, y: 0 }, size: { width: 1600, height: 1000 } });
    expect(bounds).toEqual({ x: 12, y: 12, width: 776, height: 476, minWidth: 776, minHeight: 476 });
  });

  it("centers menu-created windows on the target monitor", () => {
    expect(tabWindowBoundsInWorkArea(undefined, retina)).toMatchObject({ x: 156, y: 74 });
  });
});
