import { strict as assert } from "node:assert";
import test from "node:test";
import { orderPinnedFirst } from "../src/lib/pinnedItems.js";

test("orders pinned items before unpinned items without changing relative order", () => {
  const items = [
    { id: "a" },
    { id: "b", pinned: true },
    { id: "c" },
    { id: "d", pinned: true },
    { id: "e" },
  ];

  const ordered = orderPinnedFirst(items, (item) => !!item.pinned);

  assert.deepEqual(ordered.map((item) => item.id), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d", "e"]);
});
