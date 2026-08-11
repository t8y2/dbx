import { describe, expect, it } from "vitest";
import { MAX_QUERY_RESULT_MAX_ROWS, agentProtocolQueryResultMaxRows, capQueryResultTotal, continuousQueryResultMaxRows, effectiveQueryResultMaxRows, limitQueryPagination, normalizeQueryResultMaxRows, queryResultLimitReached } from "../queryResultRowLimit";

describe("query result row limits", () => {
  it("preserves the legacy 100,000-row default", () => {
    expect(effectiveQueryResultMaxRows(undefined, undefined)).toBe(100_000);
    expect(effectiveQueryResultMaxRows(true, 250_000)).toBe(250_000);
  });

  it("uses the Java signed-int boundary for unlimited Agent execution", () => {
    expect(effectiveQueryResultMaxRows(false, 100_000)).toBeUndefined();
    expect(agentProtocolQueryResultMaxRows(undefined)).toBe(MAX_QUERY_RESULT_MAX_ROWS);
    expect(continuousQueryResultMaxRows(false, 100_000)).toBe(MAX_QUERY_RESULT_MAX_ROWS);
    expect(continuousQueryResultMaxRows(true, 250_000)).toBe(250_000);
    expect(normalizeQueryResultMaxRows(MAX_QUERY_RESULT_MAX_ROWS + 1)).toBe(MAX_QUERY_RESULT_MAX_ROWS);
  });

  it("limits the final page and caps totals", () => {
    expect(limitQueryPagination({ limit: 100, offset: 950 }, 1_000)).toEqual({ limit: 50, offset: 950 });
    expect(limitQueryPagination({ limit: 100, offset: 2_000 }, 1_000)).toEqual({ limit: 1, offset: 999 });
    expect(queryResultLimitReached(950, 50, 1_000)).toBe(true);
    expect(queryResultLimitReached(900, 50, 1_000)).toBe(false);
    expect(capQueryResultTotal(1_500, 1_000)).toBe(1_000);
    expect(capQueryResultTotal(1_500, undefined)).toBe(1_500);
  });
});
