import { strict as assert } from "node:assert";
import test from "node:test";
import {
  canTreeNodeExpand,
  canTreeNodeShowExpander,
  treeItemPaddingLeft,
  usesFullWidthTreeLabel,
} from "../../apps/desktop/src/lib/sidebarTreeItemLayout.ts";

test("treeItemPaddingLeft converts tree depth to sidebar indentation", () => {
  assert.equal(treeItemPaddingLeft(0), "8px");
  assert.equal(treeItemPaddingLeft(1), "24px");
  assert.equal(treeItemPaddingLeft(2), "40px");
});

test("canTreeNodeExpand only returns true for expandable sidebar node types", () => {
  assert.equal(canTreeNodeExpand("connection"), true);
  assert.equal(canTreeNodeExpand("database"), true);
  assert.equal(canTreeNodeExpand("schema"), true);
  assert.equal(canTreeNodeExpand("table"), true);
  assert.equal(canTreeNodeExpand("view"), true);
  assert.equal(canTreeNodeExpand("saved-sql-root"), true);
  assert.equal(canTreeNodeExpand("saved-sql-folder"), true);

  assert.equal(canTreeNodeExpand("saved-sql-file"), false);
  assert.equal(canTreeNodeExpand("object-browser"), false);
  assert.equal(canTreeNodeExpand("column"), false);
  assert.equal(canTreeNodeExpand("index"), false);
  assert.equal(canTreeNodeExpand("redis-db"), false);
  assert.equal(canTreeNodeExpand("mongo-collection"), false);
});

test("canTreeNodeShowExpander hides empty saved SQL containers", () => {
  assert.equal(canTreeNodeShowExpander({ type: "saved-sql-root", childCount: 0 }), false);
  assert.equal(canTreeNodeShowExpander({ type: "saved-sql-folder", childCount: 0 }), false);
  assert.equal(canTreeNodeShowExpander({ type: "saved-sql-root", childCount: 1 }), true);
  assert.equal(canTreeNodeShowExpander({ type: "saved-sql-folder", childCount: 1 }), true);
});

test("usesFullWidthTreeLabel only expands object names when horizontal scroll is enabled", () => {
  assert.equal(usesFullWidthTreeLabel("table", true), true);
  assert.equal(usesFullWidthTreeLabel("view", true), true);
  assert.equal(usesFullWidthTreeLabel("mongo-collection", true), true);

  assert.equal(usesFullWidthTreeLabel("table", false), false);
  assert.equal(usesFullWidthTreeLabel("connection", true), false);
  assert.equal(usesFullWidthTreeLabel("schema", true), false);
  assert.equal(usesFullWidthTreeLabel("column", true), false);
});
