import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

/**
 * The Ctrl+F overlay was the only grid search/filter surface without tab-keyed
 * persistence (structured filters and column widths already had it), so switching
 * data tabs dropped the query along with the scroll position (#8524).
 */
function readSource(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("DataGrid keys search persistence the same way as its pending-edit snapshot", () => {
  const source = readSource("apps/desktop/src/components/grid/DataGrid.vue");
  assert.match(source, /persistenceKey: \(\) => props\.pendingStateKey \?\? props\.cacheKey,/);
  assert.match(source, /persistenceScopeKey: \(\) => createDataGridSearchScopeKey\(props\.result\.columns\),/);
});

test("search state is restored from onMounted, not the setup body", () => {
  const source = readSource("apps/desktop/src/components/grid/DataGrid.vue");
  // watch(matchKeys) evaluates its source eagerly, and a non-empty restored query
  // would push matchState past its empty-query early return into `displayItems`,
  // which is declared thousands of lines later in this same setup.
  assert.match(source, /onMounted\(\(\) => dataGridSearch\.restorePersistedState\(\)\);/);
  const restoreIndex = source.indexOf("onMounted(() => dataGridSearch.restorePersistedState());");
  const displayItemsIndex = source.indexOf("const displayItems");
  assert.notEqual(restoreIndex, -1);
  assert.notEqual(displayItemsIndex, -1);
  assert.ok(restoreIndex < displayItemsIndex, "the restore hook is registered before displayItems is declared, so it must run in onMounted");
});

test("restoring a query does not steal the viewport from the scroll restore", () => {
  const source = readSource("apps/desktop/src/composables/useDataGridSearch.ts");
  const start = source.indexOf("watch(matchKeys");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n  });", start));
  assert.match(body, /const restored = restoreToken;\s*\n\s*restoreToken = null;/, "the token must be consumed exactly once");
  assert.match(body, /if \(restored\) \{[\s\S]*?Math\.min\(Math\.max\(restored\.matchIndex, 0\), value\.length - 1\)[\s\S]*?return;/, "a restored match index is clamped and must not auto-navigate");
});

test("closed tabs release their persisted search state", () => {
  const source = readSource("apps/desktop/src/stores/queryStore.ts");
  const filterCalls = source.match(/clearDataGridStructuredFilterStatesForTab\(/g) ?? [];
  const searchCalls = source.match(/clearDataGridSearchStatesForTab\(/g) ?? [];
  assert.ok(filterCalls.length > 1, "expected the structured-filter cleanup call sites");
  // One import plus one call per cleanup site, mirroring the filter cache.
  assert.equal(searchCalls.length, filterCalls.length, "every structured-filter cleanup site must also clear the search cache");
});
