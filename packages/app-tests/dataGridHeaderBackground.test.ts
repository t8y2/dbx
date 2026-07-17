import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "vue/compiler-sfc";

test("unused header width keeps the result background", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const { descriptor } = parse(source, { filename: "DataGrid.vue" });
  const style = descriptor.styles.map((block) => block.content).join("\n");

  assert.match(style, /\.data-grid-header-shell\s*\{[^}]*background-color:\s*var\(--background\)/s);
  assert.match(style, /\.data-grid-header-cell\s*\{[^}]*background-color:\s*rgb\(239, 239, 239\)/s);
  assert.doesNotMatch(style, /\.data-grid-header-shell\s*,\s*\.data-grid-header-cell/);
  assert.doesNotMatch(style, /data-grid--dark\s+\.data-grid-header-shell/);
});
