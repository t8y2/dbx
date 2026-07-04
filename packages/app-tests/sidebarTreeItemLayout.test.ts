import { test } from "vitest";
import assert from "node:assert/strict";
import { canTreeNodePin, canTreeNodeShowExpander } from "../../apps/desktop/src/lib/sidebar/sidebarTreeItemLayout.ts";

test("mongodb collection rows can show an expander for metadata groups", () => {
  assert.equal(canTreeNodeShowExpander({ type: "mongo-collection", childCount: 0 }), true);
});

test("ZooKeeper root rows do not show an empty expander", () => {
  assert.equal(canTreeNodeShowExpander({ type: "zookeeper-root", childCount: 0 }), false);
});

test("Nacos namespace rows can show the pin action", () => {
  assert.equal(canTreeNodePin("nacos-namespace"), true);
});
