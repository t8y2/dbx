import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { canFetchNextDataGridSegment, canGoNextDataGridPage, hasCompleteLocalDataGridResult, resolveDataGridPaginationTotal } from "../../apps/desktop/src/lib/dataGrid/dataGridPagination.ts";

test("estimated display totals do not become pagination bounds", () => {
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 10_000_000,
      totalRowCountIsExact: false,
    }),
    undefined,
  );
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 10_000_000,
      totalRowCountIsExact: true,
    }),
    10_000_000,
  );
  assert.equal(
    resolveDataGridPaginationTotal({
      paginationTotalRowCount: 500,
      serverKnownTotalRowCount: 10_000_000,
      totalRowCountIsExact: false,
    }),
    500,
  );
});

test("first query page is complete when its known total is already loaded", () => {
  assert.equal(
    hasCompleteLocalDataGridResult({
      isResultsContext: true,
      rowCount: 2,
      pageLimit: 500,
      pageOffset: 0,
      totalRowCount: 2,
      truncated: false,
      hasMore: false,
    }),
    true,
  );
});

test("local query result is incomplete when rows are truncated or start after the first page", () => {
  const completeFirstPage = {
    isResultsContext: true,
    rowCount: 500,
    pageLimit: 500,
    pageOffset: 0,
    totalRowCount: 500,
    truncated: false,
    hasMore: false,
  };
  assert.equal(hasCompleteLocalDataGridResult({ ...completeFirstPage, truncated: true }), false);
  assert.equal(hasCompleteLocalDataGridResult({ ...completeFirstPage, pageOffset: 500, totalRowCount: 1000 }), false);
  assert.equal(hasCompleteLocalDataGridResult({ ...completeFirstPage, totalRowCount: undefined }), false);
});

test("known total disables next page at the last exact page", () => {
  assert.equal(
    canGoNextDataGridPage({
      rowCount: 1,
      pageSize: 1,
      pageOffset: 8,
      totalRowCount: 9,
    }),
    false,
  );
});

test("known total allows next page before the last page", () => {
  assert.equal(
    canGoNextDataGridPage({
      rowCount: 1,
      pageSize: 1,
      pageOffset: 7,
      totalRowCount: 9,
    }),
    true,
  );
});

test("backend hasMore takes precedence over a stale known total", () => {
  assert.equal(
    canGoNextDataGridPage({
      hasMore: true,
      rowCount: 1,
      pageSize: 1,
      pageOffset: 8,
      totalRowCount: 9,
    }),
    true,
  );
});

test("unknown total falls back to full-page heuristic", () => {
  assert.equal(canGoNextDataGridPage({ rowCount: 1, pageSize: 1 }), true);
  assert.equal(canGoNextDataGridPage({ rowCount: 0, pageSize: 1 }), false);
});

test("user LIMIT equal to the page size ends pagination instead of offering an empty page", () => {
  // `select top 100 ...` at pageSize 100 fills the page exactly, so the
  // full-page heuristic alone cannot tell "last page" from "more to come" and
  // offers a next page that returns zero rows. The planner reports the user's
  // own bound as the total, which resolves the ambiguity.
  assert.equal(canGoNextDataGridPage({ rowCount: 100, pageSize: 100, pageOffset: 0 }), true);
  assert.equal(canGoNextDataGridPage({ rowCount: 100, pageSize: 100, pageOffset: 0, totalRowCount: 100 }), false);
});

test("user LIMIT larger than the page size still pages up to the bound", () => {
  // `select ... limit 500` at pageSize 100 must page normally and stop at 500.
  assert.equal(canGoNextDataGridPage({ rowCount: 100, pageSize: 100, pageOffset: 0, totalRowCount: 500 }), true);
  assert.equal(canGoNextDataGridPage({ rowCount: 100, pageSize: 100, pageOffset: 300, totalRowCount: 500 }), true);
  assert.equal(canGoNextDataGridPage({ rowCount: 100, pageSize: 100, pageOffset: 400, totalRowCount: 500 }), false);
});

test("infinite scroll compares cumulative loaded rows with a known total", () => {
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 1_000, pageSize: 1_000, totalRowCount: 2_000 }), true);
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 2_000, pageSize: 1_000, totalRowCount: 2_000 }), false);
});

test("infinite scroll stops on a short unknown segment and probes a full unknown segment", () => {
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 673, pageSize: 1_000 }), false);
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 1_000, pageSize: 1_000 }), true);
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 2_000, pageSize: 1_000 }), true);
});

test("infinite scroll preserves authoritative has-more and complete-local-result signals", () => {
  assert.equal(canFetchNextDataGridSegment({ hasMore: true, loadedRowCount: 673, pageSize: 1_000, totalRowCount: 673 }), true);
  assert.equal(canFetchNextDataGridSegment({ loadedRowCount: 1_000, pageSize: 1_000, allRowsLoaded: true }), false);
});

// --- auto-redirect page calculation after refresh ---
// These tests document the math used in DataGrid.vue's loading watcher:
//   lastPageNum = Math.max(1, Math.ceil(total / pageSize))
//   redirect when currentPage > lastPageNum

test("auto-redirect: current page beyond last page after data deletion — should redirect", () => {
  // user on page 5, data shrinks to 200 rows, pageSize=100 → last page=2
  const total = 200;
  const pageSize = 100;
  const currentPage = 5;
  const lastPageNum = Math.max(1, Math.ceil(total / pageSize));
  assert.equal(lastPageNum, 2);
  assert.equal(currentPage > lastPageNum, true, "redirect should be triggered");
  assert.equal((lastPageNum - 1) * pageSize, 100, "paginate offset for last page should be 100");
});

test("auto-redirect: current page still valid after partial deletion — no redirect", () => {
  // user on page 5, data still has 500 rows → last page stays 5
  const total = 500;
  const pageSize = 100;
  const currentPage = 5;
  const lastPageNum = Math.max(1, Math.ceil(total / pageSize));
  assert.equal(lastPageNum, 5);
  assert.equal(currentPage > lastPageNum, false, "no redirect should be triggered");
});

test("auto-redirect: fewer rows than one page — redirects to page 1", () => {
  // user on page 3, data shrinks to 30 rows, pageSize=100 → last page=1
  const total = 30;
  const pageSize = 100;
  const currentPage = 3;
  const lastPageNum = Math.max(1, Math.ceil(total / pageSize));
  assert.equal(lastPageNum, 1, "ceil(30/100)=1, max(1,1)=1");
  assert.equal(currentPage > lastPageNum, true, "redirect should be triggered");
  assert.equal((lastPageNum - 1) * pageSize, 0, "paginate offset for page 1 should be 0");
});

test("auto-redirect: total is zero — guard prevents redirect attempt", () => {
  // When total=0, the '!total || total <= 0' guard fires and skips the redirect
  const total = 0;
  assert.equal(!total || total <= 0, true, "guard should prevent redirect when total is 0");
});

test("auto-redirect: total is undefined — guard prevents redirect attempt", () => {
  const total = undefined;
  assert.equal(!total || (total as any) <= 0, true, "guard should prevent redirect when total is unknown");
});

test("last-page COUNT shows grid busy overlay before executeQuery", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /const gridSurfaceBusy = computed\(\(\) => isRefreshingData\.value \|\| props\.loading === true \|\| totalRowCountBusy\.value\)/);
  assert.match(source, /v-if="gridSurfaceBusy"/);
  assert.match(source, /async function beginManualTotalRowCount/);
  assert.match(source, /await nextTick\(\);/);
  const lastPageFn = source.match(/async function lastPage\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(lastPageFn, /beginManualTotalRowCount\(\)/);
  assert.match(lastPageFn, /buildCurrentCountTarget\(\)/);
  assert.ok(lastPageFn.indexOf("beginManualTotalRowCount") < lastPageFn.indexOf("buildCurrentCountTarget"), "busy UI must start before COUNT SQL is built");
});

test("last page always re-counts when a count path is available", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const lastPageFn = source.match(/async function lastPage\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const knownTotalIdx = lastPageFn.indexOf("hasKnownPaginationTotalRowCount");
  const countCallbackIdx = lastPageFn.indexOf("props.countTotalRows");
  const countSqlIdx = lastPageFn.indexOf("buildCurrentCountTarget");
  assert.ok(countCallbackIdx >= 0 && countSqlIdx >= 0, "last page must keep count paths");
  assert.ok(knownTotalIdx < 0 || knownTotalIdx > countSqlIdx, "known totals are only a fallback after re-COUNT");
});

test("jumping to last page does not rewrite indexes before the new page loads", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const jumpFn = source.match(/function jumpToCountedLastPage\(total: number\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(jumpFn, /emit\("paginate"/);
  assert.doesNotMatch(jumpFn, /currentPage\.value\s*=/);
  assert.match(source, /function rowNumberPageOffset/);
});

test("row number gutter width tracks the largest visible row index", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  assert.match(source, /dataGridRowNumberColumnWidth/);
  assert.match(source, /resolveDataGridMaxRowNumber/);
  assert.match(source, /rowNumberWidth,/);
});
