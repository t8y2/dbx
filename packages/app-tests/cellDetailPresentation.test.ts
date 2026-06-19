import assert from "node:assert/strict";
import { test } from "vitest";
import { visibleCellDetailTabs } from "../../apps/desktop/src/lib/cellDetailPresentation.ts";

test("visibleCellDetailTabs exposes hex viewer only for binary details", () => {
  assert.deepEqual(visibleCellDetailTabs({ isEditable: false }), ["details"]);
  assert.deepEqual(visibleCellDetailTabs({ isEditable: false, hasBinaryHexViewer: true }), ["details", "hexViewer"]);
});

test("visibleCellDetailTabs preserves value editor ordering", () => {
  assert.deepEqual(visibleCellDetailTabs({ isEditable: true, hasBinaryHexViewer: true }), ["details", "hexViewer", "valueEditor"]);
});
