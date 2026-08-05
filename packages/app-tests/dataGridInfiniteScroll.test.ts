import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dataGridScrollPosition, isDataGridNearScrollBottom, isDataGridPrefixAppend, shouldCheckInfiniteScrollAfterScroll } from "../../apps/desktop/src/lib/dataGrid/dataGridInfiniteScroll.ts";

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

test("prefix-only append preserves the existing result identity", () => {
  const first = [1, "Ada"];
  const second = [2, "Linus"];
  const previous = { rows: [first, second] };
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, second, [3, "Grace"]], appended_from_row_count: 2 }), true);
});

test("append marker does not preserve state when an existing row was replaced", () => {
  const first = [1, "Ada"];
  const second = [2, "Linus"];
  const previous = { rows: [first, second] };
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, [...second], [3, "Grace"]], appended_from_row_count: 2 }), false);
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, second, [3, "Grace"]] }), false);
});

test("infinite scroll requests only the next bounded segment", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /function infiniteScrollNextPage\(\) \{[\s\S]*?if \(!canFetchNextInfiniteScrollSegment\.value\) \{[\s\S]*?infiniteScrollAllLoaded = true;[\s\S]*?return;[\s\S]*?\}/);
  assert.match(source, /const nextOffset = props\.result\.rows\.length/);
  assert.match(source, /Math\.min\(pageSize\.value, remainingRows\)/);
  assert.doesNotMatch(source, /emit\("paginate", 0, cumulativeLimit/);
  assert.match(source, /props\.result\.appended_from_row_count !== requestedOffset/);
});
