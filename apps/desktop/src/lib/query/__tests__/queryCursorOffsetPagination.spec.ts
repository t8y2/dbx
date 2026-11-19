import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { executeCursorOffsetPage } from "../queryCursorOffsetPagination";

const page = (ref: string, more = true): QueryResult => ({
  columns: ["payload"],
  rows: [[ref]],
  affected_rows: 0,
  execution_time_ms: 1,
  session_id: more ? "cursor" : undefined,
  has_more: more,
  large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 67108864, value_ref: ref }],
  large_value_refs: [ref],
});

describe("cursor offset original-value ownership", () => {
  it("releases skipped pages but retains the requested page", async () => {
    const skipped = page("skipped");
    const requested = page("requested", false);
    const releaseResults = vi.fn(async () => {});
    const result = await executeCursorOffsetPage({
      offset: 1,
      limit: 1,
      fetchPage: vi.fn().mockResolvedValueOnce([skipped]).mockResolvedValueOnce([requested]),
      closeSession: vi.fn(),
      isCancelled: () => false,
      releaseResults,
    });
    expect(releaseResults.mock.calls).toEqual([[[skipped]]]);
    expect(result[0]?.large_value_refs).toEqual(["requested"]);
  });

  it("releases a late page before closing its cancelled cursor", async () => {
    const late = page("late");
    let cancelled = false;
    const operations: string[] = [];
    await expect(
      executeCursorOffsetPage({
        offset: 1,
        limit: 1,
        fetchPage: async () => {
          cancelled = true;
          return [late];
        },
        isCancelled: () => cancelled,
        releaseResults: async (results) => {
          expect(results).toEqual([late]);
          operations.push("release");
        },
        closeSession: async () => {
          operations.push("close");
        },
      }),
    ).rejects.toThrow("Query canceled");
    expect(operations).toEqual(["release", "close"]);
  });

  it("does not attach discarded references to an exhausted empty result", async () => {
    const exhausted = page("discarded", false);
    const releaseResults = vi.fn(async () => {});
    const result = await executeCursorOffsetPage({
      offset: 2,
      limit: 1,
      fetchPage: async () => [exhausted],
      closeSession: vi.fn(),
      isCancelled: () => false,
      releaseResults,
    });
    expect(result[0]?.rows).toEqual([]);
    expect(result[0]?.large_value_cells).toEqual([]);
    expect(result[0]?.large_value_refs).toEqual([]);
    expect(releaseResults).toHaveBeenCalledWith([exhausted]);
  });
});
