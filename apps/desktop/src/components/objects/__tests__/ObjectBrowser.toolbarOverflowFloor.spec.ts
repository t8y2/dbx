import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #9200: when the "Browse Objects" pane is narrow, the keyword search box
// collapsed to a sliver and the "全部/表/视图" chips were painted on top of it,
// instead of the toolbar condensing its controls into the overflow menu.
//
// useToolbarOverflow only condenses while the row reports real overflow, and its
// contract requires "non-shrinking (shrink-0) or floored (min-w-*) children":
//   1. the collapsed search wrapper was `min-w-0`, so the wrapper dropped to 0
//      width while the input inside still painted at its padding width (58px),
//      drawing on top of the neighbouring filter chips;
//   2. the search + filter group carried `min-w-24`, which overrode the
//      content-based minimum and let the group shrink below its own content, so
//      its children spilled into the sort control instead of overflowing the row;
//   3. the filter chips allowed their labels to wrap, so the group's min-content
//      (longest word) was far below the width the chips actually occupy.
// Each of the three is load-bearing; removing any one of them brings the overlap
// back at some pane width.

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

describe("ObjectBrowser toolbar condenses instead of overlapping when narrow", () => {
  it("floors the search box and lets the search + filter group keep its content minimum", () => {
    // The floored wrapper keeps the input from painting over its neighbours, and
    // dropping `min-w-24` lets the group's content-based minimum stop the spill
    // into the sort control, so the row reports overflow instead.
    expect(objectBrowserSource).toMatch(/<div class="flex flex-1 items-center gap-2">\s*<div class="relative min-w-\[6rem\] flex-1">/);
  });

  it("pins the filter chips to their single-line width so the row reports overflow", () => {
    expect(objectBrowserSource).toMatch(/<button\s+v-for="filter in objectFilters"[\s\S]*?class="h-6 shrink-0 whitespace-nowrap rounded-sm/);
  });
});
