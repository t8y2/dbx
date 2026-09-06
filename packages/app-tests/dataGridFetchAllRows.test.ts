import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const dataGridPaginationSource = readFileSync("apps/desktop/src/components/grid/DataGridPagination.vue", "utf8");
const dataGridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
const contentAreaSource = readFileSync("apps/desktop/src/components/layout/ContentArea.vue", "utf8");

test("the page-size dropdown stays available in infinite-scroll mode so 'load all rows' has an entry point", () => {
  // Previously gated behind `!infiniteScrollEnabled`, which hid the only menu
  // that can host the fetch-all-rows entry whenever infinite scroll was on.
  assert.doesNotMatch(dataGridPaginationSource, /<LightDropdown[\s\S]{0,400}v-if="paginationEnabled && !infiniteScrollEnabled"/);
  assert.match(dataGridPaginationSource, /<template v-if="paginationEnabled">\s*<LightDropdown/);
});

test("page navigation controls hide while a fetch-all-rows result is accumulated", () => {
  assert.match(dataGridPaginationSource, /<template v-if="paginationEnabled && !infiniteScrollEnabled && !accumulatedRows">/);
});

test("the 'all loaded' label does not claim completion while a fetch-all-rows batch is still in flight", () => {
  // accumulatedRows goes true the instant loading starts (so nav hides immediately),
  // but the label must wait for fetchingAllRows to clear before saying "all loaded".
  assert.match(dataGridPaginationSource, /<span v-if="infiniteScrollAllLoaded \|\| \(accumulatedRows && !fetchingAllRows\)"/);
  assert.match(dataGridSource, /:fetching-all-rows="fetchAllRowsLoadingState"/);
});

test("the fetch-all-rows menu entry is appended to the page-size menu with a separator", () => {
  assert.match(dataGridSource, /const FETCH_ALL_ROWS_MENU_VALUE = "__fetch_all_rows__"/);
  assert.match(
    dataGridSource,
    /if \(fetchAllRowsAvailable\.value\) \{\s*items\.push\(\{\s*value: FETCH_ALL_ROWS_MENU_VALUE,\s*label: fetchAllRowsMenuLabel\.value,\s*separatorBefore: true,\s*disabled: fetchAllRowsMenuDisabled\.value,/,
  );
});

test("selecting the fetch-all-rows menu entry is intercepted before it reaches changePageSize", () => {
  assert.match(
    dataGridSource,
    /function selectPageSizeMenuItem\(value: string\) \{\s*if \(value === FETCH_ALL_ROWS_MENU_VALUE\) \{[\s\S]*?\breturn;\s*\}\s*changePageSize\(Number\(value\)\);/,
  );
});

test("the fetch-all-rows menu entry is disabled for non-paginable SQL, local sort, and an already-complete result", () => {
  assert.match(dataGridSource, /if \(props\.pageLimit === undefined \|\| props\.sortMode === "local"\) return true;/);
  assert.match(dataGridSource, /if \(accumulatedRowsMode\.value && props\.result\.has_more !== true\) return true;/);
});

test("accumulated-rows mode covers both the in-progress load and the already-appended result", () => {
  // Must be true from the moment loading starts (fetchAllRowsLoadingState), not
  // only once the first batch has landed (appended_from_row_count) -- otherwise
  // pagination controls stay visible during the first batch's request.
  assert.match(dataGridSource, /const accumulatedRowsMode = computed\(\(\) => isResultsContext\.value && \(props\.result\.appended_from_row_count !== undefined \|\| fetchAllRowsLoadingState\.value\)\)/);
});

test("keyboard pagination shortcuts are disabled while rows are accumulated, so Ctrl+PgDn cannot overwrite them", () => {
  assert.match(dataGridSource, /function handleGridPaginationShortcut\(event: KeyboardEvent\): boolean \{\s*if \(!props\.paginationEnabled \|\| gridPaginationBusy\.value \|\| infiniteScrollEnabled\.value \|\| accumulatedRowsMode\.value\) return false;/);
});

test("an in-flight fetch-all-rows loop is stopped when the grid unmounts (e.g. switching tabs)", () => {
  assert.match(dataGridSource, /onUnmounted\(\(\) => \{\s*if \(fetchAllRowsLoadingState\.value\) stopFetchAllRows\(\);\s*\}\);/);
});

test("the confirmation dialog forces a prompt above the warn threshold regardless of the suppress preference", () => {
  assert.match(dataGridSource, /:show-suppress-toggle="!fetchAllRowsWarnLarge"/);
  assert.match(dataGridSource, /if \(!suppressFetchAllRowsConfirm\.value \|\| shouldWarnFetchAllRows\(knownTotal, cap, QUERY_RESULT_FETCH_ALL_WARN_ROWS\)\) \{/);
});

test("only the query-results grid (not the table-data grid) is wired for fetch-all-rows", () => {
  const wiredOccurrences = contentAreaSource.match(/supports-fetch-all-rows/g) ?? [];
  assert.equal(wiredOccurrences.length, 1, "supports-fetch-all-rows must be wired on exactly one DataGrid instance");
  const eventOccurrences = contentAreaSource.match(/@fetch-all-rows="emit\('fetchAllRows', activeTab\.id\)"/g) ?? [];
  assert.equal(eventOccurrences.length, 1);
});
