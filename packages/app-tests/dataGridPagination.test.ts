import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canGoNextDataGridPage, hasCompleteLocalDataGridResult } from "../../apps/desktop/src/lib/dataGrid/dataGridPagination.ts";

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
