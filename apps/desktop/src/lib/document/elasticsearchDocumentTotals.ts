export interface ElasticsearchDocumentTotals {
  total: number;
  totalIsExact: boolean;
  paginationTotal: number;
}

export interface ResetElasticsearchDocumentTotals {
  total: undefined;
  totalIsExact: boolean;
  paginationTotal?: number;
}

export function resolveElasticsearchDocumentTotals(searchTotal: number, searchTotalIsExact: boolean, exactCount?: number): ElasticsearchDocumentTotals {
  if (searchTotalIsExact || exactCount === undefined) {
    return {
      total: searchTotal,
      totalIsExact: searchTotalIsExact,
      paginationTotal: searchTotal,
    };
  }
  return {
    total: exactCount,
    totalIsExact: true,
    paginationTotal: Math.min(searchTotal, exactCount),
  };
}

export function resetElasticsearchDocumentTotals(paginationTotal: number | undefined, preservePaginationTotal = false): ResetElasticsearchDocumentTotals {
  return {
    total: undefined,
    totalIsExact: true,
    paginationTotal: preservePaginationTotal ? paginationTotal : undefined,
  };
}

export function clampDocumentPage(page: number, pageSize: number, paginationTotal?: number): number {
  const normalizedPage = Math.max(0, Math.floor(page));
  if (paginationTotal === undefined) return normalizedPage;
  if (paginationTotal <= 0) return 0;
  const lastPage = Math.max(0, Math.ceil(paginationTotal / Math.max(1, pageSize)) - 1);
  return Math.min(normalizedPage, lastPage);
}

export function documentPageRequestLimit(page: number, pageSize: number, paginationTotal?: number): number {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  if (paginationTotal === undefined) return normalizedPageSize;
  const remaining = paginationTotal - Math.max(0, Math.floor(page)) * normalizedPageSize;
  return remaining > 0 ? Math.min(normalizedPageSize, remaining) : normalizedPageSize;
}
