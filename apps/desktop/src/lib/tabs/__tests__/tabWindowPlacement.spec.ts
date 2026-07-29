import { describe, expect, it } from "vitest";
import { DETACHED_TAB_WINDOW_HEIGHT, DETACHED_TAB_WINDOW_WIDTH, detachedTabWindowLogicalPosition, detachedTabWindowPreviewRect, pointOutsideRect } from "@/lib/tabs/tabWindowPlacement";

describe("detached tab window placement", () => {
  it("shows the final window aspect ratio and keeps the preview in the viewport", () => {
    const preview = detachedTabWindowPreviewRect({ x: 900, y: 500 }, { width: 1000, height: 700 });

    expect(preview.width / preview.height).toBeCloseTo(DETACHED_TAB_WINDOW_WIDTH / DETACHED_TAB_WINDOW_HEIGHT);
    expect(preview.left).toBeGreaterThanOrEqual(12);
    expect(preview.top).toBeGreaterThanOrEqual(12);
    expect(preview.left + preview.width).toBeLessThanOrEqual(988);
    expect(preview.top + preview.height).toBeLessThanOrEqual(688);
    expect(preview.scale).toBeLessThan(1);
  });

  it("applies a tolerance around the tab bar before detaching", () => {
    const tabBar = { left: 0, top: 0, right: 1000, bottom: 40 };

    expect(pointOutsideRect({ x: 500, y: 47 }, tabBar, 8)).toBe(false);
    expect(pointOutsideRect({ x: 500, y: 49 }, tabBar, 8)).toBe(true);
  });

  it("converts the preview origin to Tauri logical desktop coordinates", () => {
    const position = detachedTabWindowLogicalPosition({ x: 300, y: 150 }, 1.5, 1.8, { left: 100, top: 50 });

    expect(position).toEqual({ x: 320, y: 160 });
  });
});
