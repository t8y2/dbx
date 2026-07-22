import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dataGridScrollPosition, isDataGridNearScrollBottom, shouldCheckInfiniteScrollAfterScroll } from "../../apps/desktop/src/lib/dataGrid/dataGridInfiniteScroll.ts";

test("horizontal-only scroll does not check infinite scroll", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(240, 0), dataGridScrollPosition(240, 180)), false);
});

test("shift-wheel horizontal scroll near the bottom does not check infinite scroll", () => {
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 120 }), true);
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(0, 0), dataGridScrollPosition(0, 320)), false);
});

test("vertical scroll checks infinite scroll even when horizontal offset also changes", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(240, 0), dataGridScrollPosition(360, 180)), true);
});

test("first scroll position only establishes the infinite scroll baseline", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(undefined, dataGridScrollPosition(360, 180)), false);
});

test("near-bottom check matches the grid threshold", () => {
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 801, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }), false);
});

test("infinite scroll requests only the next bounded segment", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /const nextOffset = props\.result\.rows\.length/);
  assert.match(source, /Math\.min\(pageSize\.value, remainingRows\)/);
  assert.doesNotMatch(source, /emit\("paginate", 0, cumulativeLimit/);
  assert.match(source, /props\.result\.appended_from_row_count !== requestedOffset/);
});
