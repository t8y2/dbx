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

test("whole-row selection keeps its own deeper tokens in both render modes", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  // DOM 模式：整行选中使用专属深色 token（亮色 blue-400 / 暗色加深蓝）
  assert.match(source, /--data-grid-row-selected-bg:\s*rgb\(96,\s*165,\s*250\)/);
  assert.match(source, /--data-grid-row-selected-bg:\s*rgb\(30,\s*74,\s*128\)/);
  assert.match(source, /"--data-grid-row-selected-bg":\s*dark \? "rgb\(30, 74, 128\)" : "rgb\(96, 165, 250\)"/);
  assert.match(source, /--data-grid-row-selected-dirty-bg:\s*rgb\(199,\s*185,\s*120\)/);
  assert.match(source, /\.row-cell-selected\s*\{\s*background-color:\s*var\(--data-grid-row-selected-bg\) !important;/);
  assert.match(source, /\.row-cell-selected-dirty\s*\{\s*background-color:\s*var\(--data-grid-row-selected-dirty-bg\) !important;/);
  // 选区覆盖淡色指示保持原浅色，不随整行选中加深
  assert.match(source, /\.data-grid-row-number--in-selection\s*\{\s*background-color:\s*var\(--data-grid-cell-selected-bg\);/);
});
