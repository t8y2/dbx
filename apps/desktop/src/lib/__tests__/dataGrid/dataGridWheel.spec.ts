import { describe, expect, it } from "vitest";
import { shouldCheckInfiniteScrollAfterScroll } from "@/lib/dataGrid/dataGridInfiniteScroll";
import { resolveDataGridWheelScroll, type DataGridWheelMetrics } from "@/lib/dataGrid/dataGridWheel";

const metrics: DataGridWheelMetrics = {
  scrollTop: 100,
  scrollLeft: 200,
  scrollHeight: 800,
  scrollWidth: 1000,
  clientHeight: 300,
  clientWidth: 400,
};

function resolveWheel(overrides: Partial<Parameters<typeof resolveDataGridWheelScroll>[0]> = {}) {
  return resolveDataGridWheelScroll({
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    lineSize: 28,
    metrics,
    ...overrides,
  });
}

describe("data grid wheel scrolling", () => {
  it.each([
    { deltaX: 120, nextScrollLeft: 320 },
    { deltaX: -120, nextScrollLeft: 80 },
  ])("keeps pixel deltaX at 1:1 with Canvas acceleration ($deltaX)", ({ deltaX, nextScrollLeft }) => {
    expect(resolveWheel({ deltaX, accelerationFactor: 1.5 })).toEqual({
      scrollDeltaX: deltaX,
      scrollDeltaY: 0,
      nextScrollTop: 100,
      nextScrollLeft,
      moved: true,
    });
  });

  it("normalizes line deltas with the configured row height", () => {
    expect(resolveWheel({ deltaX: 2, deltaY: -3, deltaMode: 1 })).toMatchObject({
      scrollDeltaX: 56,
      scrollDeltaY: -84,
      nextScrollTop: 16,
      nextScrollLeft: 256,
      moved: true,
    });
  });

  it("normalizes page deltas with the matching viewport dimensions", () => {
    expect(resolveWheel({ deltaX: 1, deltaY: 1, deltaMode: 2 })).toMatchObject({
      scrollDeltaX: 400,
      scrollDeltaY: 300,
      nextScrollTop: 400,
      nextScrollLeft: 600,
      moved: true,
    });
  });

  it("turns Shift plus deltaY into horizontal-only movement", () => {
    expect(resolveWheel({ deltaY: 40, shiftKey: true, accelerationFactor: 1.5 })).toMatchObject({
      scrollDeltaX: 60,
      scrollDeltaY: 0,
      nextScrollTop: 100,
      nextScrollLeft: 260,
      moved: true,
    });
  });

  it("keeps plain deltaY vertical", () => {
    expect(resolveWheel({ deltaY: 40 })).toMatchObject({
      scrollDeltaX: 0,
      scrollDeltaY: 40,
      nextScrollTop: 140,
      nextScrollLeft: 200,
      moved: true,
    });
  });

  it("preserves both pixel axes without Canvas acceleration for diagonal input", () => {
    expect(resolveWheel({ deltaX: 30, deltaY: 20, accelerationFactor: 1.5 })).toMatchObject({
      scrollDeltaX: 30,
      scrollDeltaY: 20,
      nextScrollTop: 120,
      nextScrollLeft: 230,
      moved: true,
    });
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])("leaves modified wheel input untouched (%o)", (modifier) => {
    expect(resolveWheel({ deltaX: 120, deltaY: 40, ...modifier })).toEqual({
      scrollDeltaX: 0,
      scrollDeltaY: 0,
      nextScrollTop: 100,
      nextScrollLeft: 200,
      moved: false,
    });
  });

  it("clamps movement to both scroll boundaries", () => {
    expect(resolveWheel({ deltaX: 1000, deltaY: -1000 })).toMatchObject({
      nextScrollTop: 0,
      nextScrollLeft: 600,
      moved: true,
    });
  });

  it("hands horizontal input to an outer scroller at the relevant boundary", () => {
    expect(
      resolveWheel({
        deltaX: 120,
        metrics: { ...metrics, scrollLeft: 600 },
      }),
    ).toMatchObject({
      nextScrollTop: 100,
      nextScrollLeft: 600,
      moved: false,
    });
  });

  it("does not trigger infinite pagination for horizontal-only movement", () => {
    const wheelScroll = resolveWheel({ deltaX: 120 });

    expect(shouldCheckInfiniteScrollAfterScroll({ top: metrics.scrollTop, left: metrics.scrollLeft }, { top: wheelScroll.nextScrollTop, left: wheelScroll.nextScrollLeft })).toBe(false);
  });

  it("does not consume input when the grid has no overflow", () => {
    expect(
      resolveWheel({
        deltaX: 120,
        deltaY: 40,
        metrics: {
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 300,
          scrollWidth: 400,
          clientHeight: 300,
          clientWidth: 400,
        },
      }),
    ).toMatchObject({
      nextScrollTop: 0,
      nextScrollLeft: 0,
      moved: false,
    });
  });
});
