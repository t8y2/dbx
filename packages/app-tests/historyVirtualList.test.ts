import { strict as assert } from "node:assert";
import { test } from "vitest";
import { HISTORY_ROW_HEIGHT, HISTORY_SCROLL_BUFFER, shouldVirtualizeHistory } from "../../apps/desktop/src/lib/historyVirtualList.ts";

test("history list virtualizes every non-empty result set", () => {
  assert.equal(shouldVirtualizeHistory(0), false);
  assert.equal(shouldVirtualizeHistory(1), true);
  assert.equal(shouldVirtualizeHistory(1000), true);
});

test("history virtual list keeps enough buffer for smooth scrolling", () => {
  assert.equal(HISTORY_ROW_HEIGHT, 72);
  assert.ok(HISTORY_SCROLL_BUFFER >= HISTORY_ROW_HEIGHT * 6);
});
