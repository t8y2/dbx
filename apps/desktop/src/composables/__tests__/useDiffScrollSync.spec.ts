import { ref } from "vue";
import { describe, expect, it } from "vitest";
import type { DiffHunk } from "@/components/diff/DiffHunkBuilder";
import { useDiffScrollSync } from "@/composables/useDiffScrollSync";

function createPane(scrollTop: number, scrollLeft: number): HTMLElement {
  return { scrollTop, scrollLeft } as HTMLElement;
}

function createScrollSync(leftPane: HTMLElement, rightPane: HTMLElement) {
  return useDiffScrollSync({
    container: ref<HTMLElement>(),
    leftPane: ref<HTMLElement | undefined>(leftPane),
    rightPane: ref<HTMLElement | undefined>(rightPane),
    hunks: ref<DiffHunk[]>([]),
  });
}

describe("useDiffScrollSync", () => {
  it("syncs vertical and horizontal scroll from left to right", () => {
    const leftPane = createPane(100, 240);
    const rightPane = createPane(0, 0);
    const { syncScroll } = createScrollSync(leftPane, rightPane);

    syncScroll("left");

    expect(rightPane.scrollTop).toBe(100);
    expect(rightPane.scrollLeft).toBe(240);
  });

  it("syncs vertical and horizontal scroll from right to left", () => {
    const leftPane = createPane(0, 0);
    const rightPane = createPane(80, 160);
    const { syncScroll } = createScrollSync(leftPane, rightPane);

    syncScroll("right");

    expect(leftPane.scrollTop).toBe(80);
    expect(leftPane.scrollLeft).toBe(160);
  });
});
