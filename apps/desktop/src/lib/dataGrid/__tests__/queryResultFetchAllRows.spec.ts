import { describe, expect, it } from "vitest";
import { QUERY_RESULT_FETCH_ALL_WARN_ROWS, beginFetchAllRows, endFetchAllRows, isFetchAllRowsStopRequested, isFetchingAllRows, requestStopFetchAllRows, shouldWarnFetchAllRows } from "../queryResultFetchAllRows";

describe("shouldWarnFetchAllRows", () => {
  it("does not warn at the default 100,000-row cap even when the total is unknown", () => {
    expect(shouldWarnFetchAllRows(undefined, 100_000)).toBe(false);
  });

  it("warns once the effective amount to load (bounded by the cap) exceeds the threshold", () => {
    expect(shouldWarnFetchAllRows(2_000_000, 100_000)).toBe(false); // capped well under the threshold
    expect(shouldWarnFetchAllRows(2_000_000, QUERY_RESULT_FETCH_ALL_WARN_ROWS * 2)).toBe(true); // cap raised past the threshold
    expect(shouldWarnFetchAllRows(500_000, QUERY_RESULT_FETCH_ALL_WARN_ROWS * 2)).toBe(false); // known total under threshold
  });

  it("treats an unknown total as the full cap for the warning decision", () => {
    expect(shouldWarnFetchAllRows(undefined, QUERY_RESULT_FETCH_ALL_WARN_ROWS * 2)).toBe(true);
    expect(shouldWarnFetchAllRows(undefined, QUERY_RESULT_FETCH_ALL_WARN_ROWS)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(shouldWarnFetchAllRows(600, 100_000, 500)).toBe(true);
    expect(shouldWarnFetchAllRows(400, 100_000, 500)).toBe(false);
  });
});

describe("fetch-all-rows running state", () => {
  it("tracks one loop per tab id and refuses to double-start", () => {
    const tabId = "tab-1";
    expect(isFetchingAllRows(tabId)).toBe(false);
    expect(beginFetchAllRows(tabId)).toBe(true);
    expect(isFetchingAllRows(tabId)).toBe(true);
    expect(beginFetchAllRows(tabId)).toBe(false); // must not allow a second concurrent loop for the same tab
    endFetchAllRows(tabId);
    expect(isFetchingAllRows(tabId)).toBe(false);
  });

  it("scopes the stop flag to the tab it was requested for", () => {
    const tabA = "tab-a";
    const tabB = "tab-b";
    beginFetchAllRows(tabA);
    beginFetchAllRows(tabB);
    requestStopFetchAllRows(tabB);
    expect(isFetchAllRowsStopRequested(tabA)).toBe(false);
    expect(isFetchAllRowsStopRequested(tabB)).toBe(true);
    endFetchAllRows(tabA);
    endFetchAllRows(tabB);
  });

  it("requesting a stop for a tab with no active loop is a no-op", () => {
    requestStopFetchAllRows("no-such-tab");
    expect(isFetchAllRowsStopRequested("no-such-tab")).toBe(false);
  });
});
