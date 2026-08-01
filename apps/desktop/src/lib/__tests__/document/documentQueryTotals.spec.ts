import { describe, expect, it } from "vitest";
import { canGoNextDocumentPage, exactTotalFromIncompleteDocumentPage, isSameDocumentQueryTotalCountRequest, resolveDocumentQueryTotals, type DocumentQueryTotalCountRequest } from "@/lib/document/documentQueryTotals";

describe("document query totals", () => {
  it("uses exact totals as the pagination bound", () => {
    expect(resolveDocumentQueryTotals(42, true)).toEqual({
      total: 42,
      totalIsExact: true,
      paginationTotal: 42,
    });
    expect(canGoNextDocumentPage({ page: 3, pageSize: 10, rowCount: 10, paginationTotal: 42 })).toBe(true);
    expect(canGoNextDocumentPage({ page: 4, pageSize: 10, rowCount: 2, paginationTotal: 42 })).toBe(false);
  });

  it("does not use estimated totals as the pagination bound", () => {
    expect(resolveDocumentQueryTotals(10_000_000, false)).toEqual({
      total: 10_000_000,
      totalIsExact: false,
      paginationTotal: undefined,
    });
    expect(canGoNextDocumentPage({ page: 999_999, pageSize: 10, rowCount: 10 })).toBe(true);
    expect(canGoNextDocumentPage({ page: 1_000_000, pageSize: 10, rowCount: 3 })).toBe(false);
  });

  it("treats a short page as an exact total even when the backend estimate is inexact", () => {
    expect(exactTotalFromIncompleteDocumentPage({ page: 0, pageSize: 500, rowCount: 0 })).toBe(0);
    expect(exactTotalFromIncompleteDocumentPage({ page: 0, pageSize: 500, rowCount: 1 })).toBe(1);
    expect(resolveDocumentQueryTotals(1, false, { page: 0, pageSize: 500, rowCount: 1 })).toEqual({
      total: 1,
      totalIsExact: true,
      paginationTotal: 1,
    });
    expect(resolveDocumentQueryTotals(50, false, { page: 1, pageSize: 500, rowCount: 12 })).toEqual({
      total: 512,
      totalIsExact: true,
      paginationTotal: 512,
    });
    expect(resolveDocumentQueryTotals(658_320, false, { page: 0, pageSize: 500, rowCount: 500 })).toEqual({
      total: 658_320,
      totalIsExact: false,
      paginationTotal: undefined,
    });
  });

  it("does not infer an exact total from an empty page after the first page", () => {
    expect(exactTotalFromIncompleteDocumentPage({ page: 1, pageSize: 500, rowCount: 0 })).toBeUndefined();
    expect(resolveDocumentQueryTotals(658_320, false, { page: 1, pageSize: 500, rowCount: 0 })).toEqual({
      total: 658_320,
      totalIsExact: false,
      paginationTotal: undefined,
    });
  });

  it("matches exact-count requests across identity, filter, and generation", () => {
    const request: DocumentQueryTotalCountRequest = {
      connectionId: "connection-a",
      database: "database-a",
      collection: "collection-a",
      filter: '{"active":true}',
      generation: 3,
    };
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request })).toBe(true);
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request, connectionId: "connection-b" })).toBe(false);
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request, database: "database-b" })).toBe(false);
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request, collection: "collection-b" })).toBe(false);
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request, filter: undefined })).toBe(false);
    expect(isSameDocumentQueryTotalCountRequest(request, { ...request, generation: 4 })).toBe(false);
  });
});
