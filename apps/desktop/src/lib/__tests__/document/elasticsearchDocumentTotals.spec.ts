import { describe, expect, it } from "vitest";
import { clampDocumentPage, documentPageRequestLimit, resetElasticsearchDocumentTotals, resolveElasticsearchDocumentTotals } from "@/lib/document/elasticsearchDocumentTotals";

describe("Elasticsearch document totals", () => {
  it("keeps a lower-bound search total separate from an exact background count", () => {
    expect(resolveElasticsearchDocumentTotals(10_000, false)).toEqual({
      total: 10_000,
      totalIsExact: false,
      paginationTotal: 10_000,
    });
    expect(resolveElasticsearchDocumentTotals(10_000, false, 552_033)).toEqual({
      total: 552_033,
      totalIsExact: true,
      paginationTotal: 10_000,
    });
  });

  it("uses exact search totals for both display and pagination", () => {
    expect(resolveElasticsearchDocumentTotals(42, true, 100)).toEqual({
      total: 42,
      totalIsExact: true,
      paginationTotal: 42,
    });
  });

  it("clears a stale display total without losing the safe page cap during a refresh", () => {
    expect(resetElasticsearchDocumentTotals(10_000, true)).toEqual({
      total: undefined,
      totalIsExact: true,
      paginationTotal: 10_000,
    });
    expect(resetElasticsearchDocumentTotals(10_000)).toEqual({
      total: undefined,
      totalIsExact: true,
      paginationTotal: undefined,
    });
  });

  it("clamps the final request without exceeding the conservative page cap", () => {
    expect(clampDocumentPage(30, 333, 10_000)).toBe(30);
    expect(clampDocumentPage(31, 333, 10_000)).toBe(30);
    expect(documentPageRequestLimit(30, 333, 10_000)).toBe(10);
    expect(documentPageRequestLimit(0, 100, undefined)).toBe(100);
  });
});
