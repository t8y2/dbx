import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("data grid selection colors stay on the classic blue palette", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /--data-grid-cell-selected-bg:\s*rgb\(239,\s*246,\s*255\)/);
  assert.match(source, /--data-grid-cell-selected-border:\s*rgb\(59,\s*130,\s*246\)/);
  assert.match(source, /"--data-grid-cell-selected-bg":\s*dark \? "rgb\(20, 40, 60\)" : "rgb\(239, 246, 255\)"/);
  assert.doesNotMatch(source, /--data-grid-cell-selected-border:\s*color-mix\(in srgb, var\(--ring\)/);
  assert.doesNotMatch(source, /--data-grid-cell-selected-bg:\s*color-mix\(in srgb, var\(--primary\)/);
});
