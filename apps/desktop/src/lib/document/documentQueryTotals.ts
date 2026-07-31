export interface DocumentQueryTotals {
  total: number;
  totalIsExact: boolean;
  paginationTotal: number | undefined;
}

export interface DocumentQueryTotalsPageOptions {
  page?: number;
  pageSize?: number;
  rowCount?: number;
}

/** When the current page is short, the true total is exactly offset + rowCount. */
export function exactTotalFromIncompleteDocumentPage(options: DocumentQueryTotalsPageOptions): number | undefined {
  const pageSize = options.pageSize;
  const rowCount = options.rowCount;
  if (typeof pageSize !== "number" || pageSize <= 0 || typeof rowCount !== "number" || rowCount < 0 || rowCount >= pageSize) {
    return undefined;
  }
  return Math.max(0, options.page ?? 0) * pageSize + rowCount;
}

export function resolveDocumentQueryTotals(total: number, totalIsExact: boolean, pageOptions?: DocumentQueryTotalsPageOptions, options?: { retainExactTotal?: number }): DocumentQueryTotals {
  if (!totalIsExact) {
    const exactFromPage = exactTotalFromIncompleteDocumentPage(pageOptions ?? {});
    if (typeof exactFromPage === "number") {
      return {
        total: exactFromPage,
        totalIsExact: true,
        paginationTotal: exactFromPage,
      };
    }
    if (typeof options?.retainExactTotal === "number" && Number.isFinite(options.retainExactTotal) && options.retainExactTotal >= 0) {
      return {
        total: options.retainExactTotal,
        totalIsExact: true,
        paginationTotal: options.retainExactTotal,
      };
    }
  }
  return {
    total,
    totalIsExact,
    paginationTotal: totalIsExact ? total : undefined,
  };
}

export function canGoNextDocumentPage(options: { page: number; pageSize: number; rowCount: number; paginationTotal?: number }): boolean {
  if (typeof options.paginationTotal === "number") {
    return (options.page + 1) * options.pageSize < options.paginationTotal;
  }
  return options.rowCount >= options.pageSize;
}
