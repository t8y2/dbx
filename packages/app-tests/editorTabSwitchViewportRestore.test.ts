import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

/**
 * The shared editor swaps documents on tab switches (per-tab EditorState cache
 * since the undo-isolation fix). Both branches of that swap — the cached
 * `setState` path AND the uncached `swapEditorDocument` path (first activation
 * in this editor instance, or a tab evicted from the state cache) — must
 * restore the incoming tab's saved cursor and scroll position. Skipping the
 * restore on the uncached branch is what made switching back to a tab land on
 * line 1 instead of the previous viewport (#8374).
 */
function activateTabDocumentSource(): string {
  const source = readFileSync(path.resolve("apps/desktop/src/components/editor/QueryEditor.vue"), "utf8");
  const start = source.indexOf("function activateTabDocument");
  assert.notEqual(start, -1, "expected activateTabDocument in QueryEditor.vue");
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, "expected activateTabDocument closing brace");
  return source.slice(start, end);
}

test("uncached tab activation restores the saved cursor and scroll position", () => {
  const source = activateTabDocumentSource();
  assert.match(source, /if \(!cached\) \{[\s\S]*?swapEditorDocument\(doc\);[\s\S]*?restoreEditorSelection\([^;]*\);[\s\S]*?restoreEditorViewport\([^;]*\);[\s\S]*?return;/, "the swapEditorDocument branch must restore selection and viewport before returning");
});

test("uncached tabs without saved state do not inherit the previous tab position", () => {
  const source = activateTabDocumentSource();
  assert.match(source, /restoreEditorSelection\(props\.initialSelection \?\? \{ anchor: 0, head: 0 \}\);/);
  assert.match(source, /restoreEditorViewport\(props\.initialViewport \?\? \{ scrollTop: 0, scrollLeft: 0 \}\);/);
});

test("cached tab activation keeps restoring selection and viewport", () => {
  const source = activateTabDocumentSource();
  assert.match(source, /currentView\.setState\(cached\);/);
  assert.match(source, /currentView\.setState\(cached\);[\s\S]*?restoreEditorSelection\(\);\s*restoreEditorViewport\(\);/);
});

test("viewport restore prefers the per-tab saved viewport", () => {
  const source = readFileSync(path.resolve("apps/desktop/src/components/editor/QueryEditor.vue"), "utf8");
  assert.match(source, /function restoreEditorViewport\(viewport = props\.initialViewport \?\? latestViewport\) \{/);
});
