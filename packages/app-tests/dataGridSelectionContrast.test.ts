import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("data grid selection outline uses ring/primary tokens instead of flat border", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /--data-grid-cell-selected-border:\s*color-mix\(in srgb, var\(--ring\) 55%, var\(--primary\)\)/);
  assert.doesNotMatch(source, /"--data-grid-cell-selected-border":\s*"var\(--border\)"/);
  assert.doesNotMatch(source, /"--data-grid-cell-selected-bg":\s*"var\(--accent\)"/);
});
