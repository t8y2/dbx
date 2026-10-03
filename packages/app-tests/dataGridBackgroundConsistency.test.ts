import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { resolveDataGridPaintTheme } from "../../apps/desktop/src/lib/dataGrid/dataGridPaintTheme.ts";

test("DataGrid DOM surfaces use one opaque theme background", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

  assert.match(source, /\[data-grid-root\]\s*\{[^}]*--data-grid-background:\s*var\(--background-solid,\s*var\(--background\)\);[^}]*background-color:\s*var\(--data-grid-background\);/s);
  assert.match(source, /\[data-grid-root\]\.data-grid--dark,\s*:global\(\.dark\)\s*\[data-grid-root\]\s*\{[^}]*background-color:\s*var\(--data-grid-background\);/s);

  assert.match(source, /\.canvas-grid-scroller\s*\{[^}]*background-color:\s*var\(--data-grid-background\);/s);
  assert.match(source, /\.data-grid-scroller:not\(\.canvas-grid-scroller\)\s*\{[^}]*background-color:\s*var\(--data-grid-background\);/s);
  assert.match(source, /\.data-grid-scroller:not\(\.canvas-grid-scroller\)\s+:deep\(\.vue-recycle-scroller__item-wrapper\),[^}]*background-color:\s*var\(--data-grid-background\);/s);

  assert.match(source, /\.data-grid-cell--frozen\s*\{[^}]*background-color:\s*var\(--data-grid-cell-bg,\s*var\(--data-grid-background\)\)\s*!important;/s);
  assert.match(source, /\.data-grid-horizontal-scrollbar\s*\{[^}]*background-color:\s*var\(--data-grid-background\);/s);
  assert.match(source, /:global\(\.dark\)\s*\[data-grid-root\]\s+\.data-grid-vertical-scrollbar\s*\{[^}]*background-color:\s*var\(--data-grid-background\);/s);

  assert.match(source, /item\.displayIndex % 2 === 1[\s\S]*?:\s*"var\(--data-grid-background\)";/);

  assert.doesNotMatch(source, /(?:canvas-grid-scroller|data-grid-scroller)[^}]*background-color:\s*var\(--background\)/s);
});

test("DataGrid canvas background stays opaque when the wallpaper background has alpha", () => {
  const getThemeBackground = (varBackground: string, solidBackground: string, dataGridBackground: string, isDark: boolean) => {
    return resolveDataGridPaintTheme({
      getVar: (name) =>
        ({
          "--background": varBackground,
          "--background-solid": solidBackground,
          "--data-grid-background": dataGridBackground,
        })[name] ?? "",
      isDark,
    }).background;
  };

  assert.equal(getThemeBackground("rgb(43 43 43 / 0.05)", "rgb(43 43 43)", "rgb(43 43 43)", true), "rgb(43, 43, 43)");
  assert.equal(getThemeBackground("rgb(255 252 242 / 0.3)", "rgb(255 252 242)", "", false), "rgb(255, 252, 242)");
  assert.equal(getThemeBackground("rgb(30, 30, 30)", "", "", true), "rgb(30, 30, 30)");
});
