import { describe, expect, it } from "vitest";
import { ELASTICSEARCH_PAGE_JUMP_WARNING_REQUESTS, elasticsearchCursorPageJumpRequestCount, hasCompleteLocalDataGridResult, reconcileDataGridExactTotalWithObservedPage } from "@/lib/dataGrid/dataGridPagination";

describe("Elasticsearch cursor page jumps", () => {
  it("counts only missing forward cursors", () => {
    expect(elasticsearchCursorPageJumpRequestCount(1, 101)).toBe(100);
    expect(elasticsearchCursorPageJumpRequestCount(101, 102)).toBe(1);
  });

  it("counts a backward jump from the page-one restart", () => {
    expect(elasticsearchCursorPageJumpRequestCount(104, 103)).toBe(103);
    expect(elasticsearchCursorPageJumpRequestCount(104, 1)).toBe(1);
  });

  it("warns starting at one hundred sequential requests", () => {
    expect(elasticsearchCursorPageJumpRequestCount(1, 100)).toBeLessThan(ELASTICSEARCH_PAGE_JUMP_WARNING_REQUESTS);
    expect(elasticsearchCursorPageJumpRequestCount(1, 101)).toBe(ELASTICSEARCH_PAGE_JUMP_WARNING_REQUESTS);
  });
});

describe("complete local DataGrid results", () => {
  it("recognizes complete results without treating a partial page as complete", () => {
    expect(
      hasCompleteLocalDataGridResult({
        isResultsContext: true,
        rowCount: 3,
        pageLimit: 10,
        pageOffset: 0,
        truncated: false,
        hasMore: false,
      }),
    ).toBe(true);
    expect(
      hasCompleteLocalDataGridResult({
        isResultsContext: true,
        rowCount: 10,
        pageLimit: 10,
        pageOffset: 0,
        totalRowCount: 25,
        truncated: false,
        hasMore: false,
      }),
    ).toBe(false);
    expect(
      hasCompleteLocalDataGridResult({
        isResultsContext: true,
        rowCount: 20,
        pageLimit: 10,
        pageOffset: 10,
        totalRowCount: 20,
        truncated: false,
        hasMore: false,
      }),
    ).toBe(false);
  });
});

describe("reconciling an exact total with an observed page (#10968)", () => {
  it("adopts the observed extent when a page lands past the counted total", () => {
    // Issue screenshot: COUNT said 2892, but the counted last page (offset 2800,
    // 200 rows) came back full from a snapshot holding more rows.
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: 200, exactTotal: 2892 })).toBe(3000);
  });

  it("keeps the counted total for pages that fit inside it", () => {
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: 92, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 0, rowCount: 200, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 400, rowCount: 200, exactTotal: 2892 })).toBeUndefined();
  });

  it("keeps the counted total when the page comes back short at its end", () => {
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: 92, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: 0, exactTotal: 2892 })).toBeUndefined();
  });

  it("extends a zero or missing total as soon as rows are on screen", () => {
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 0, rowCount: 5, exactTotal: 0 })).toBe(5);
  });

  it("ignores malformed offsets, rows, and totals", () => {
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: -1, rowCount: 200, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: -1, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: Number.NaN, rowCount: 200, exactTotal: 2892 })).toBeUndefined();
    expect(reconcileDataGridExactTotalWithObservedPage({ offset: 2800, rowCount: 200, exactTotal: Number.NaN })).toBeUndefined();
  });
});
