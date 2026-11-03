import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const editor = readFileSync("apps/desktop/src/components/structure/TableStructureEditor.vue", "utf8");

function cssRule(selector: string): string {
  const start = editor.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  return editor.slice(start, editor.indexOf("}", start));
}

test("structure editor sticky headers stay opaque over a wallpaper (#14065)", () => {
  // Wallpaper mode makes --background translucent, so rows scrolled under a
  // sticky header showed through it. Headers must use the solid surface token.
  const columnHeaderSlot = cssRule(".structure-column-virtual-scroller :deep(.vue-recycle-scroller__slot)");
  assert.match(columnHeaderSlot, /position: sticky;/);
  assert.match(columnHeaderSlot, /background: var\(--background-solid, var\(--background\)\);/);

  assert.match(editor, /<thead class="bg-background-solid">\s*<tr>\s*<th\s+v-for="\(columnLabel, i\) in colLabels"/);
  assert.match(editor, /\[structureHeaderCellClass, 'bg-background-solid select-none'/);
  assert.match(editor, /<thead class="sticky top-0 z-10 bg-background-solid">/);
  assert.doesNotMatch(editor, /<thead class="[^"]*\bbg-background\b(?!-)/);
});
