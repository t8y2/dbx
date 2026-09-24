import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canFetchNextDataGridSegment, canGoNextDataGridPage, dataGridLoadAllSegment, hasCompleteLocalDataGridResult, resolveDataGridPaginationTotal } from "../../apps/desktop/src/lib/dataGrid/dataGridPagination.ts";

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

test("exact display totals keep pagination inside the configured result cap", () => {
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 175_390,
      totalRowCountIsExact: true,
      maxRows: 100_000,
    }),
    100_000,
  );
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 99_999,
      totalRowCountIsExact: true,
      maxRows: 100_000,
    }),
    99_999,
  );
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 100_000,
      totalRowCountIsExact: true,
      maxRows: 100_000,
    }),
    100_000,
  );
  assert.equal(
    resolveDataGridPaginationTotal({
      serverKnownTotalRowCount: 175_390,
      totalRowCountIsExact: true,
    }),
    175_390,
  );
});

test("large table pagination keeps the real last page and deep page offset", () => {
  const totalRows = 3_374_023;
  const pageSize = 100;
  const tablePaginationTotal = resolveDataGridPaginationTotal({
    serverKnownTotalRowCount: totalRows,
    totalRowCountIsExact: true,
  });
  const queryPaginationTotal = resolveDataGridPaginationTotal({
    serverKnownTotalRowCount: totalRows,
    totalRowCountIsExact: true,
    maxRows: 100_000,
  });

  assert.equal(tablePaginationTotal, totalRows);
  assert.equal(queryPaginationTotal, 100_000);

  const lastPage = Math.max(1, Math.ceil((tablePaginationTotal ?? 0) / pageSize));
  assert.equal(lastPage, 33_741);
  assert.equal((lastPage - 1) * pageSize, 3_374_000);
  assert.equal((2_000 - 1) * pageSize, 199_900);
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

test("load-all requests every remaining row up to the configured cap", () => {
  assert.deepEqual(dataGridLoadAllSegment(100, 5_000, true), { offset: 100, limit: 4_900 });
  assert.deepEqual(dataGridLoadAllSegment(2_500, 5_000, true), { offset: 2_500, limit: 2_500 });
});

test("load-all does not request past the cap or after the result is complete", () => {
  assert.equal(dataGridLoadAllSegment(5_000, 5_000, true), null);
  assert.equal(dataGridLoadAllSegment(100, 5_000, false), null);
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
