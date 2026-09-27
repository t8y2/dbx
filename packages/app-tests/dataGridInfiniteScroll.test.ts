import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dataGridScrollPosition, isDataGridNearScrollBottom, isDataGridPrefixAppend, shouldCheckInfiniteScrollAfterScroll } from "../../apps/desktop/src/lib/dataGrid/dataGridInfiniteScroll.ts";

test("horizontal-only scroll does not check infinite scroll", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(240, 0), dataGridScrollPosition(240, 180)), false);
});

test("shift-wheel horizontal scroll near the bottom does not check infinite scroll", () => {
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 120 }), true);
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(0, 0), dataGridScrollPosition(0, 320)), false);
});

test("vertical scroll checks infinite scroll even when horizontal offset also changes", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(dataGridScrollPosition(240, 0), dataGridScrollPosition(360, 180)), true);
});

test("first scroll position only establishes the infinite scroll baseline", () => {
  assert.equal(shouldCheckInfiniteScrollAfterScroll(undefined, dataGridScrollPosition(360, 180)), false);
});

test("near-bottom check matches the grid threshold", () => {
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 801, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isDataGridNearScrollBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }), false);
});

test("prefix-only append preserves the existing result identity", () => {
  const first = [1, "Ada"];
  const second = [2, "Linus"];
  const previous = { rows: [first, second] };
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, second, [3, "Grace"]], appended_from_row_count: 2 }), true);
});

test("append marker does not preserve state when an existing row was replaced", () => {
  const first = [1, "Ada"];
  const second = [2, "Linus"];
  const previous = { rows: [first, second] };
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, [...second], [3, "Grace"]], appended_from_row_count: 2 }), false);
  assert.equal(isDataGridPrefixAppend(previous, { rows: [first, second, [3, "Grace"]] }), false);
});

test("load-all selects the last loaded row only after a valid append completes", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const contentAreaSource = readFileSync("apps/desktop/src/components/layout/ContentArea.vue", "utf8");
  const querySurfacesSource = readFileSync("apps/desktop/src/components/layout/querySurfaces.ts", "utf8");
  const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");
  const documentBrowserSource = readFileSync("apps/desktop/src/components/document/DocumentBrowser.vue", "utf8");
  // loadAllRowsAndGoToLast hands the actual fetch to startLoadAllRows after the
  // ES guard and the large-shot confirmation, so extract both bodies.
  const loadAllFn = source.match(/function loadAllRowsAndGoToLast\(\) \{[\s\S]*?\nfunction confirmLoadAllRows\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(loadAllFn, /gridSurfaceBusy\.value \|\| infiniteScrollLoading\.value/);
  assert.match(loadAllFn, /dataGridLoadAllSegment/);
  assert.match(loadAllFn, /if \(!segment\) \{[\s\S]*?selectAndRevealLastLoadedRow\(\);[\s\S]*?return;/);
  assert.match(loadAllFn, /resolvedDatabaseType\.value === "elasticsearch" \|\| resolvedDatabaseType\.value === "easysearch"/);
  assert.match(loadAllFn, /LOAD_ALL_ROWS_CONFIRM_ROW_THRESHOLD/);
  assert.match(loadAllFn, /infiniteScrollLoadAllPending = true/);
  assert.match(loadAllFn, /emit\("paginate", segment\.offset, segment\.limit, currentWhereInput\(\), currentOrderBy\(\), true\)/);
  assert.match(source, /\(\) => \[props\.loading, props\.result\.rows\.length, props\.result\.appended_from_row_count\] as const[\s\S]*?\{ flush: "post" \}/);
  assert.match(source, /props\.result\.appended_from_row_count !== requestedOffset[\s\S]*?return;[\s\S]*?if \(shouldSelectLastRow\) selectAndRevealLastLoadedRow\(\)/);
  assert.match(source, /function selectAndRevealLastLoadedRow\(\)[\s\S]*?selectRow\(rowIndex\)[\s\S]*?remainingFrames = 12[\s\S]*?scrollCanvasRowIntoView\(rowIndex, "end"\)[\s\S]*?scrollDomRowIntoView\(rowIndex, "end"\)[\s\S]*?requestAnimationFrame\(revealWhenReady\)/);
  assert.match(source, /\(\) => \[props\.countSql \?\? ""[\s\S]*?manualTotalRowCount\.value = undefined/);
  assert.match(source, /if \(infiniteScrollLoadAllPending\) \{[\s\S]*?infiniteScrollLoadAllPending = false;[\s\S]*?selectAndRevealLastLoadedRow\(\)/);
  assert.match(source, /dataGridInfiniteScrollAppendCompletion\(previousResult, result,[\s\S]*?loadAllRowsActive\.value = false/);
  assert.match(querySurfacesSource, /paginate: \[tabId: string, offset: number, limit: number, whereInput\?: string, orderBy\?: string, appendResult\?: boolean\]/);
  // App.vue's inline handler must forward appendResult, or "load all" silently
  // degrades into replacing the result with the fetched segment.
  assert.match(appSource, /@paginate="\(tabId: string, offset: number, limit: number, whereInput\?: string, orderBy\?: string, appendResult\?: boolean\) => onPaginate\(tabId, offset, limit, whereInput, orderBy, appendResult\)"/);
  assert.equal(contentAreaSource.match(/emit\('paginate', activeTab\.id, offset, limit, whereInput, orderBy, appendResult\)/g)?.length, 2);
  assert.match(documentBrowserSource, /:load-all-rows-enabled="false"/);
  // A non-append result replacement must clear the all-loaded marker (stale all-loaded
  // used to lock scrolling and degrade the load-all button to locate-only after WHERE edits).
  const nonAppendIdx = source.indexOf("// A non-append result replaces the whole data set");
  assert.ok(nonAppendIdx > 0, "non-append replacement branch must exist");
  assert.match(source.slice(nonAppendIdx, nonAppendIdx + 420), /infiniteScrollAllLoaded = false;/);
});
