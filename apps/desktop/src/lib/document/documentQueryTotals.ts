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

export interface DocumentQueryTotalCountRequest {
  connectionId: string;
  database: string;
  collection: string;
  filter: string | undefined;
  generation: number;
}

export function isSameDocumentQueryTotalCountRequest(left: DocumentQueryTotalCountRequest, right: DocumentQueryTotalCountRequest): boolean {
  return left.connectionId === right.connectionId && left.database === right.database && left.collection === right.collection && left.filter === right.filter && left.generation === right.generation;
}

/** When the current page is short, the true total is exactly offset + rowCount. */
export function exactTotalFromIncompleteDocumentPage(options: DocumentQueryTotalsPageOptions): number | undefined {
  const page = options.page ?? 0;
  const pageSize = options.pageSize;
  const rowCount = options.rowCount;
  if (!Number.isInteger(page) || page < 0 || typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize <= 0 || typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0 || rowCount >= pageSize || (page > 0 && rowCount === 0)) {
    return undefined;
  }
  return page * pageSize + rowCount;
}

export function resolveDocumentQueryTotals(total: number, totalIsExact: boolean, pageOptions?: DocumentQueryTotalsPageOptions): DocumentQueryTotals {
  if (!totalIsExact) {
    const exactFromPage = exactTotalFromIncompleteDocumentPage(pageOptions ?? {});
    if (typeof exactFromPage === "number") {
      return {
        total: exactFromPage,
        totalIsExact: true,
        paginationTotal: exactFromPage,
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
