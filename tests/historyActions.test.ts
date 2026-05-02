import { strict as assert } from "node:assert";
import test from "node:test";
import { shouldDeleteHistoryEntry, shouldClearHistory } from "../src/lib/historyActions.ts";

test("requires confirmation before deleting history entries", () => {
  assert.equal(shouldDeleteHistoryEntry(() => false), false);
  assert.equal(shouldDeleteHistoryEntry(() => true), true);
});

test("requires existing entries and confirmation before clearing history", () => {
  assert.equal(shouldClearHistory(0, () => true), false);
  assert.equal(shouldClearHistory(2, () => false), false);
  assert.equal(shouldClearHistory(2, () => true), true);
});
