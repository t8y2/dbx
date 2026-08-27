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

// Elasticsearch rejects any from+size combination above this by default (index.max_result_window).
// DBX can't know a target index's actual configured value up front, so it clamps requests to the
// out-of-the-box default rather than letting an oversized "rows per page" preference reach the cluster as-is.
export const ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW = 10_000;

// Clamps a requested page size against the from+size window still available at a given skip offset,
// regardless of where the requested limit came from (a settings default or an explicit override).
export function clampElasticsearchRequestLimit(skip: number, limit: number): number {
  const normalizedSkip = Math.max(0, Math.floor(skip));
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return Math.min(normalizedLimit, Math.max(0, ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW - normalizedSkip));
}

export function documentPageRequestLimit(page: number, pageSize: number, paginationTotal?: number): number {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const skip = Math.max(0, Math.floor(page)) * normalizedPageSize;
  const cappedPageSize = clampElasticsearchRequestLimit(skip, normalizedPageSize);
  if (paginationTotal === undefined) return cappedPageSize;
  const remaining = paginationTotal - skip;
  return remaining > 0 ? Math.min(cappedPageSize, remaining) : cappedPageSize;
}
