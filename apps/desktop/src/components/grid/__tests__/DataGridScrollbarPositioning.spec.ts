import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Fixes #10095: the vertical/horizontal scrollbar overlays are absolutely
// positioned relative to the nearest ancestor with `position: relative`.
// Before this fix that ancestor was the grid's *outer* wrapper, which starts
// at the sticky column-header row — so `top: 10px` on the vertical scrollbar
// (and the horizontal scrollbar's `bottom: 0`) were measured from the header,
// landing the scrollbar visually on top of the header instead of below it.
const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid scrollbar positioning", () => {
  it("wraps the header-less scroll body in its own relative stacking context", () => {
    const headerEnd = dataGridSource.indexOf('<div v-if="gridScrollbarGutter > 0" class="shrink-0 border-l border-border w-(--grid-scrollbar-gutter)" />\n                </div>\n              </div>');
    expect(headerEnd).toBeGreaterThanOrEqual(0);

    const wrapperStart = dataGridSource.indexOf('<div class="relative min-h-0 flex-1 flex flex-col overflow-hidden">', headerEnd);
    expect(wrapperStart).toBeGreaterThan(headerEnd);

    // The vertical scrollbar (and its horizontal sibling) must be inside the
    // new wrapper, not siblings of the header at the outer level. Anchor on
    // the "Table Info Drawer" comment that follows the wrapper's own closing
    // tags — an inner RecycleScroller slot's `</template>` closes earlier and
    // is not a safe upper bound.
    const verticalScrollbarIndex = dataGridSource.indexOf('ref="gridVerticalScrollbarTrackRef"', wrapperStart);
    const drawerCommentIndex = dataGridSource.indexOf("<!-- Table Info Drawer -->", wrapperStart);
    expect(verticalScrollbarIndex).toBeGreaterThan(wrapperStart);
    expect(verticalScrollbarIndex).toBeLessThan(drawerCommentIndex);
  });

  it("closes the wrapper before the sticky-header template ends, leaving markup balanced", () => {
    const wrapperOpenCount = (dataGridSource.match(/<div class="relative min-h-0 flex-1 flex flex-col overflow-hidden">/g) || []).length;
    expect(wrapperOpenCount).toBe(1);
  });
});
