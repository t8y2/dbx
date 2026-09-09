import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

/**
 * Data tabs render a single active pane (`ContentArea` keyed by `activeTab.id`,
 * no KeepAlive), so returning to a tab remounts the grid from scratch. Scroll was
 * always snapshotted, but the restore gate threw away scroll-only snapshots — the
 * exact read-only-browse case — because it assumed a KeepAlive activate path that
 * does not exist. The gate now also honours snapshots written by a tab switch
 * (#8524) while a reloaded or re-executed result still starts at row 1 (#7341).
 */
function readSource(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

function editorSource(): string {
  return readSource("apps/desktop/src/composables/useDataGridEditor.ts");
}

test("the restore gate honours a tab-switch scroll snapshot", () => {
  assert.match(
    editorSource(),
    /pendingScrollRestore = snapshotHasEditState \|\| cached\.scrollFromTabSwitch === true \? cached\.scroll : undefined;/,
    "the scroll-only gate must accept snapshots carrying tab-switch provenance",
  );
});

test("the tab-switch listener only claims its own tab", () => {
  const source = editorSource();
  const start = source.indexOf("function onBeforeTabSwitch");
  assert.notEqual(start, -1, "expected onBeforeTabSwitch in useDataGridEditor.ts");
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /detail\?\.fromTabId/, "must read fromTabId off the event detail");
  assert.match(body, /cacheKeyBelongsToTab\(key, detail\.fromTabId\)/, "must validate fromTabId against this grid's cache key");
  assert.match(body, /scrollSnapshotFromTabSwitch = true/);
});

test("the snapshot records the tab-switch provenance", () => {
  assert.match(editorSource(), /scrollFromTabSwitch: scroll \? scrollSnapshotFromTabSwitch : false,/);
});

test("an explicit scroll-to-top intent drops the provenance", () => {
  const source = editorSource();
  assert.match(source, /function clearTabSwitchScrollProvenance\(\)/);
  const reset = source.slice(source.indexOf("function resetGridVerticalScroll"));
  assert.match(reset.slice(0, reset.indexOf("\n  }")), /clearTabSwitchScrollProvenance\(\);/, "resetGridVerticalScroll must clear the provenance");
  // The rows-identity watcher already clears pendingScrollRestore; it must clear
  // the cached provenance too, or a reload would inherit the old offset.
  assert.match(source, /pendingScrollRestore = undefined;\s*\n\s*clearTabSwitchScrollProvenance\(\);/);
});

test("data tab panes stay un-cached so the fix cannot be masked by KeepAlive", () => {
  // Introducing KeepAlive here would retain every grid instance in memory; the
  // snapshot path is the deliberate alternative. Pin that decision.
  for (const file of ["apps/desktop/src/components/layout/EditorGroup.vue", "apps/desktop/src/components/layout/ContentArea.vue"]) {
    assert.doesNotMatch(readSource(file), /<KeepAlive|<keep-alive/, `${file} must not wrap tab panes in KeepAlive`);
  }
});
