import { describe, expect, it } from "vitest";
import { dataGridBottomScrollTop, dataGridInfiniteScrollAppendCompletion, didDataGridInfiniteScrollContextChange, isDataGridAtScrollBottom, restoredDataGridScrollLeft } from "@/lib/dataGrid/dataGridInfiniteScroll";

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
