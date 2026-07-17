import { test } from "vitest";
import assert from "node:assert/strict";
import { canTreeNodePin, canTreeNodeShowExpander, treeLabelWidthClass } from "../../apps/desktop/src/lib/sidebar/sidebarTreeItemLayout.ts";

test("mongodb collection rows can show an expander for metadata groups", () => {
  assert.equal(canTreeNodeShowExpander({ type: "mongo-collection", childCount: 0 }), true);
});

test("ZooKeeper root rows do not show an empty expander", () => {
  assert.equal(canTreeNodeShowExpander({ type: "zookeeper-root", childCount: 0 }), false);
});

test("Nacos namespace rows can show the pin action", () => {
  assert.equal(canTreeNodePin("nacos-namespace"), true);
});

test("labels with trailing comments consume the available row width", () => {
  assert.equal(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: true }), "min-w-0 flex-1 truncate");
  assert.equal(treeLabelWidthClass({ fullWidth: false, hasTrailingComment: false }), "min-w-0 truncate");
});

test("horizontal-scroll labels keep their intrinsic width", () => {
  assert.equal(treeLabelWidthClass({ fullWidth: true, hasTrailingComment: true }), "shrink-0 whitespace-nowrap");
});
