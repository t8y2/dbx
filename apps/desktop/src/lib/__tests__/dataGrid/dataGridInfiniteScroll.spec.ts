import { describe, expect, it } from "vitest";
import { dataGridBottomScrollTop, dataGridInfiniteScrollAppendCompletion, didDataGridInfiniteScrollContextChange, isDataGridAtScrollBottom, restoredDataGridScrollLeft } from "@/lib/dataGrid/dataGridInfiniteScroll";
import { canStartDataGridLoadAll, dataGridLoadAllInitialTarget, dataGridLoadAllNextSegment } from "@/lib/dataGrid/dataGridPagination";

describe("data grid bottom anchoring", () => {
  it("keeps DOM rows anchored when scrollbar padding increases the scroll height", () => {
    const before = { scrollTop: 740, scrollHeight: 1000, clientHeight: 260 };
    const after = { scrollHeight: 1010, clientHeight: 260 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(750);
  });

  it("keeps canvas rows anchored when scrollbar margin reduces the viewport", () => {
    const before = { scrollTop: 740, scrollHeight: 1000, clientHeight: 260 };
    const after = { scrollHeight: 1000, clientHeight: 250 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(750);
  });

  it("keeps the quick-entry draft row visible after the horizontal scrollbar appears", () => {
    const before = { scrollTop: 766, scrollHeight: 1026, clientHeight: 260 };
    const after = { scrollHeight: 1036, clientHeight: 260 };

    expect(isDataGridAtScrollBottom(before)).toBe(true);
    expect(dataGridBottomScrollTop(after)).toBe(776);
  });

  it("does not anchor a user who is away from the bottom", () => {
    expect(isDataGridAtScrollBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 260 })).toBe(false);
  });

  it("does not treat an unmeasured non-scrollable grid as bottom-anchored", () => {
    expect(isDataGridAtScrollBottom({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 })).toBe(false);
  });
});

describe("data grid horizontal restoration", () => {
  it("restores the previous horizontal position after the grid remounts", () => {
    expect(restoredDataGridScrollLeft(320, 1200, 600)).toBe(320);
  });

  it("clamps the previous position when the scrollable width shrinks", () => {
    expect(restoredDataGridScrollLeft(720, 1000, 600)).toBe(400);
  });

  it("resets the position when the rebuilt grid no longer overflows", () => {
    expect(restoredDataGridScrollLeft(320, 500, 600)).toBe(0);
  });
});

describe("data grid infinite-scroll append completion", () => {
  const firstPageRows = Array.from({ length: 100 }, (_, index) => [index + 1]);

  it("stops after an incomplete cursor-backed final segment", () => {
    const completion = dataGridInfiniteScrollAppendCompletion({ rows: firstPageRows, session_id: "oracle-go-4", has_more: true }, { rows: [...firstPageRows, [101], [102], [103], [104]], appended_from_row_count: 100, has_more: false }, { pageSize: 100, maxRows: 100_000 });

    expect(completion).toEqual({ loadedPage: 2, allLoaded: true });
  });

  it("honors cursor exhaustion when the total is an exact page multiple", () => {
    const completion = dataGridInfiniteScrollAppendCompletion(
      { rows: firstPageRows, session_id: "oracle-go-5", has_more: true },
      { rows: [...firstPageRows, ...Array.from({ length: 100 }, (_, index) => [index + 101])], appended_from_row_count: 100, has_more: false },
      { pageSize: 100, maxRows: 100_000 },
    );

    expect(completion).toEqual({ loadedPage: 2, allLoaded: true });
  });

  it("keeps offset pagination available after a full non-cursor segment", () => {
    const completion = dataGridInfiniteScrollAppendCompletion({ rows: firstPageRows, has_more: false }, { rows: [...firstPageRows, ...Array.from({ length: 100 }, (_, index) => [index + 101])], appended_from_row_count: 100, has_more: false }, { pageSize: 100, maxRows: 100_000 });

    expect(completion).toEqual({ loadedPage: 2, allLoaded: false });
  });

  it("does not reset a completed append when equivalent metadata is replaced", () => {
    const context = ["SELECT COUNT(*) FROM users", "public", "users", "", "app", "connection-1"];

    expect(didDataGridInfiniteScrollContextChange([...context], context)).toBe(false);
    expect(didDataGridInfiniteScrollContextChange([...context.slice(0, 2), "audit", ...context.slice(3)], context)).toBe(true);
  });
});

describe("data grid load-all loop completion", () => {
  // #10752: an explicit "load all" run must not stop at the per-request row
  // cap. A 260k-row table with the default 100k cap appends 99,900 rows in the
  // first chunk; the cap-hit must not be reported as "all loaded".
  it("keeps a cap-sized load-all chunk going when rows remain", () => {
    const previousRows = Array.from({ length: 100 }, (_, index) => [index + 1]);
    const rows = [...previousRows, ...Array.from({ length: 99_900 }, (_, index) => [index + 101])];

    const completion = dataGridInfiniteScrollAppendCompletion({ rows: previousRows }, { rows, appended_from_row_count: 100, has_more: undefined }, { pageSize: 100, maxRows: 100_000, loadAll: { requestedLimit: 99_900 } });

    expect(completion).toEqual({ loadedPage: 1000, allLoaded: false });
  });

  it("ends the load-all run when a chunk returns fewer rows than requested", () => {
    const previousRows = Array.from({ length: 200_000 }, (_, index) => [index + 1]);
    const rows = [...previousRows, ...Array.from({ length: 60_000 }, (_, index) => [index + 200_001])];

    const completion = dataGridInfiniteScrollAppendCompletion({ rows: previousRows }, { rows, appended_from_row_count: 200_000, has_more: undefined }, { pageSize: 100, maxRows: 100_000, loadAll: { requestedLimit: 100_000 } });

    expect(completion?.allLoaded).toBe(true);
  });

  it("ends the load-all run when an exact known total has been reached", () => {
    const previousRows = Array.from({ length: 250_000 }, (_, index) => [index + 1]);
    const rows = [...previousRows, ...Array.from({ length: 10_000 }, (_, index) => [index + 250_001])];

    const completion = dataGridInfiniteScrollAppendCompletion({ rows: previousRows }, { rows, appended_from_row_count: 250_000, has_more: undefined }, { pageSize: 100, maxRows: 100_000, loadAll: { requestedLimit: 100_000, totalRowCount: 260_000 } });

    expect(completion?.allLoaded).toBe(true);
  });

  it("keeps the cap-based completion for ordinary infinite scrolls", () => {
    const previousRows = Array.from({ length: 100 }, (_, index) => [index + 1]);
    const rows = [...previousRows, ...Array.from({ length: 99_900 }, (_, index) => [index + 101])];

    const completion = dataGridInfiniteScrollAppendCompletion({ rows: previousRows }, { rows, appended_from_row_count: 100, has_more: undefined }, { pageSize: 100, maxRows: 100_000 });

    expect(completion?.allLoaded).toBe(true);
  });
});

describe("dataGridLoadAllNextSegment", () => {
  it("issues the next uncapped chunk after a full chunk", () => {
    expect(dataGridLoadAllNextSegment({ loadedRowCount: 100_000, requestedOffset: 100, requestedLimit: 99_900 })).toEqual({ offset: 100_000, limit: 99_900 });
  });

  it("trims the final chunk to an exact known total", () => {
    expect(dataGridLoadAllNextSegment({ loadedRowCount: 200_000, requestedOffset: 100_000, requestedLimit: 100_000, totalRowCount: 260_000 })).toEqual({ offset: 200_000, limit: 60_000 });
  });

  it("returns null when the exact known total has been reached", () => {
    expect(dataGridLoadAllNextSegment({ loadedRowCount: 260_000, requestedOffset: 200_000, requestedLimit: 100_000, totalRowCount: 260_000 })).toBeNull();
  });

  it("returns null when the server returned fewer rows than requested", () => {
    expect(dataGridLoadAllNextSegment({ loadedRowCount: 205_000, requestedOffset: 200_000, requestedLimit: 100_000 })).toBeNull();
  });

  it("returns null when a chunk appended nothing (loop guard)", () => {
    expect(dataGridLoadAllNextSegment({ loadedRowCount: 200_000, requestedOffset: 200_000, requestedLimit: 100_000 })).toBeNull();
  });
});

describe("dataGridLoadAllInitialTarget", () => {
  it("targets the cap or total when below the chunk limit", () => {
    expect(dataGridLoadAllInitialTarget(100, 100_000, 260_000)).toBe(100_000);
    expect(dataGridLoadAllInitialTarget(100, 100_000, 50_000)).toBe(50_000);
    expect(dataGridLoadAllInitialTarget(100, 100_000)).toBe(100_000);
  });

  it("targets the next chunk increment when already at or past the chunk limit", () => {
    expect(dataGridLoadAllInitialTarget(100_000, 100_000, 260_000)).toBe(200_000);
    expect(dataGridLoadAllInitialTarget(200_000, 100_000, 260_000)).toBe(260_000);
    expect(dataGridLoadAllInitialTarget(260_000, 100_000, 260_000)).toBe(260_000);
  });

  it("advances by chunk increment when total is unknown", () => {
    expect(dataGridLoadAllInitialTarget(100_000, 100_000)).toBe(200_000);
    expect(dataGridLoadAllInitialTarget(200_000, 100_000)).toBe(300_000);
  });
});

describe("canStartDataGridLoadAll", () => {
  const base = { loadedRowCount: 10, pageSize: 10, allRowsLoaded: false, localResultComplete: false };

  it("blocks a re-request on an exhausted result even when the total is unknown (#11321)", () => {
    // Fully loaded 10-row result (the backend's has_more stays true because the
    // first page filled the page size), marker set by the short previous chunk.
    expect(canStartDataGridLoadAll({ ...base, hasMore: true, allRowsLoaded: true })).toBe(false);
  });

  it("blocks a limit-free result that already holds every row", () => {
    // A result fetched without a page limit cannot yield more rows; paging it
    // must never re-request, even when the row count is below the page size.
    expect(canStartDataGridLoadAll({ loadedRowCount: 5, pageSize: 100, allRowsLoaded: false, localResultComplete: true })).toBe(false);
    expect(canStartDataGridLoadAll({ loadedRowCount: 5, pageSize: 100, hasMore: true, allRowsLoaded: false, localResultComplete: true })).toBe(false);
  });

  it("still starts when the marker was set by the result-row cap (#10752)", () => {
    // The load watcher also sets the marker on a cap hit — a capped result is
    // not exhausted, and load-all is the only way past the cap. has_more is
    // still true and no exact total exists, so the run must start; a genuinely
    // exhausted capped result costs one empty append before terminating.
    expect(canStartDataGridLoadAll({ loadedRowCount: 100_000, pageSize: 100, hasMore: true, allRowsLoaded: true, localResultComplete: false, resultRowCap: 100_000 })).toBe(true);
    // Below the cap the marker still blocks (#11321 shape).
    expect(canStartDataGridLoadAll({ loadedRowCount: 10, pageSize: 10, hasMore: true, allRowsLoaded: true, localResultComplete: false, resultRowCap: 100_000 })).toBe(false);
  });

  it("blocks when the exact total has already been loaded", () => {
    expect(canStartDataGridLoadAll({ ...base, hasMore: true, exactTotal: 10 })).toBe(false);
    expect(canStartDataGridLoadAll({ ...base, hasMore: undefined, exactTotal: 10 })).toBe(false);
  });

  it("keeps issuing requests while rows may remain", () => {
    expect(canStartDataGridLoadAll({ ...base, hasMore: true })).toBe(true);
    expect(canStartDataGridLoadAll({ ...base, hasMore: true, exactTotal: 260_000 })).toBe(true);
    expect(canStartDataGridLoadAll({ loadedRowCount: 100_000, pageSize: 100, hasMore: true, exactTotal: 260_000, allRowsLoaded: false, localResultComplete: false })).toBe(true);
  });

  it("falls back to the shared segment heuristic when nothing is known to be complete", () => {
    // No has_more, no total, loaded below pageSize: nothing suggests more rows.
    expect(canStartDataGridLoadAll({ loadedRowCount: 10, pageSize: 100, allRowsLoaded: false, localResultComplete: false })).toBe(false);
    // Either completion marker short-circuits before any heuristic can say yes.
    expect(canStartDataGridLoadAll({ loadedRowCount: 10, pageSize: 100, hasMore: true, allRowsLoaded: true, localResultComplete: false })).toBe(false);
  });
});
