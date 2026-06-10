import { strict as assert } from "node:assert";
import { test } from "vitest";
import { clampSearchSplitWidth, DEFAULT_SEARCH_SPLIT_RATIO, MIN_SEARCH_SPLIT_PANE_WIDTH } from "../../apps/desktop/src/lib/dataGridSearchSplit.ts";

test("defaults the search split to an even width", () => {
  assert.equal(clampSearchSplitWidth({ containerWidth: 800 }), 400);
});

test("clamps the search split to keep both panes usable", () => {
  assert.equal(clampSearchSplitWidth({ containerWidth: 800, desiredWidth: 80 }), MIN_SEARCH_SPLIT_PANE_WIDTH);
  assert.equal(clampSearchSplitWidth({ containerWidth: 800, desiredWidth: 700 }), 800 - MIN_SEARCH_SPLIT_PANE_WIDTH);
});

test("keeps the search split centered when the toolbar is narrow", () => {
  assert.equal(clampSearchSplitWidth({ containerWidth: 300, desiredWidth: 40 }), 300 * DEFAULT_SEARCH_SPLIT_RATIO);
});
