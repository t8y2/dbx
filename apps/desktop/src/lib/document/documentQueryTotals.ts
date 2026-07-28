export interface DocumentQueryTotals {
  total: number;
  totalIsExact: boolean;
  paginationTotal: number | undefined;
}

export function resolveDocumentQueryTotals(total: number, totalIsExact: boolean): DocumentQueryTotals {
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
