import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

// Regression test for #8885: when the object-browser columns are wider than the
// panel, the vertical scrollbar must stay pinned to the visible right edge
// instead of travelling with the content. The list scroller therefore owns the
// horizontal scrolling (with the content width applied to its inner item
// wrapper), while the header is clipped and aligned programmatically.
describe("ObjectBrowser vertical scrollbar viewport lock", () => {
  it("keeps the outer table container from scrolling horizontally", () => {
    const tableMatch = /class="object-browser-table[^"]*"/.exec(source);
    expect(tableMatch).not.toBeNull();
    expect(tableMatch![0]).toContain("overflow-hidden");
    expect(tableMatch![0]).not.toContain("overflow-x-auto");
  });

  it("moves the content min-width onto the scroller's inner wrapper", () => {
    const scrollerMatch = /<RecycleScroller[^>]*listScrollerRef[^>]*>/.exec(source);
    expect(scrollerMatch).not.toBeNull();
    expect(scrollerMatch![0]).toContain("--dbx-object-grid-min-width");
    expect(scrollerMatch![0]).not.toContain("minWidth:");
    expect(source).toContain(".object-browser-scroller {");
    expect(source).toContain("overflow-x: auto;");
    expect(source).toContain("min-width: var(--dbx-object-grid-min-width, 0px);");
  });

  it("clips the header and syncs its scroll position with the scroller", () => {
    const headerMatch = /ref="objectListHeaderRef"[^>]*/.exec(source);
    expect(headerMatch).not.toBeNull();
    expect(headerMatch![0]).toContain("overflow-hidden");
    expect(source).toContain("function syncObjectListHeaderScroll(");
    expect(source).toContain("header.scrollLeft = el.scrollLeft");
    // The sync runs on every scroller scroll event, when the scroller (re)attaches,
    // and whenever the column widths change the content width.
    const scrollHandler = source.indexOf("function onObjectsScroll(");
    expect(source.slice(scrollHandler, scrollHandler + 300)).toContain("syncObjectListHeaderScroll()");
    expect(source).toContain("nextTick(() => syncObjectListHeaderScroll())");
  });
});
