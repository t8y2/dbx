import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const treeItem = readFileSync("apps/desktop/src/components/sidebar/TreeItem.vue", "utf8");

test("recycled sidebar rows re-register paste handlers by node id", () => {
  assert.match(treeItem, /watch\(\s*\(\) => props\.node\.id,/);
  assert.match(treeItem, /registerPasteHandler\?\.\(nodeId, requestPasteTreeClipboard\)/);
  assert.match(treeItem, /if \(unregister\) onCleanup\(unregister\)/);
});

test("sidebar row unmount clears observers, handlers and drag state", () => {
  assert.match(treeItem, /function handleMouseLeave\(\)[\s\S]*?labelResizeObserver\?\.disconnect\(\)/);
  assert.match(treeItem, /function finishTableReferenceDrag\(\)[\s\S]*?document\.removeEventListener\("mousemove"/);
  assert.match(treeItem, /onBeforeUnmount\(\(\) => \{[\s\S]*?handleMouseLeave\(\)[\s\S]*?stopPasteHandlerRegistration\(\)[\s\S]*?finishTableReferenceDrag\(\)/);
  assert.match(treeItem, /stopDangerDialogRouting\?\.\(\)/);
});

test("sidebar rows do not own dialog templates or eager dialog state", () => {
  assert.doesNotMatch(treeItem, /<Dialog(?:\s|>)/);
  assert.doesNotMatch(treeItem, /<DangerConfirmDialog/);
  assert.doesNotMatch(treeItem, /const show[A-Z][A-Za-z]+(?:Dialog|Confirm) = ref\(/);
  assert.match(treeItem, /function getTreeItemDialogController\(\)/);
  assert.match(treeItem, /if \(treeItemDialogController\) return treeItemDialogController/);
});
