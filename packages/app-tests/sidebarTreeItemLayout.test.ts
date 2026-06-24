import { test } from "vitest";
import assert from "node:assert/strict";
import { canTreeNodeShowExpander } from "../../apps/desktop/src/lib/sidebarTreeItemLayout.ts";

test("mongodb collection rows can show an expander for metadata groups", () => {
  assert.equal(canTreeNodeShowExpander({ type: "mongo-collection", childCount: 0 }), true);
});

test("ZooKeeper root rows do not show an empty expander", () => {
  assert.equal(canTreeNodeShowExpander({ type: "zookeeper-root", childCount: 0 }), false);
});
