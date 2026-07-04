import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canGoNextDataGridPage } from "../../apps/desktop/src/lib/dataGrid/dataGridPagination.ts";

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
