import { describe, expect, it } from "vitest";
import { ELASTICSEARCH_PAGE_JUMP_WARNING_REQUESTS, elasticsearchCursorPageJumpRequestCount, hasCompleteLocalDataGridResult } from "@/lib/dataGrid/dataGridPagination";

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
