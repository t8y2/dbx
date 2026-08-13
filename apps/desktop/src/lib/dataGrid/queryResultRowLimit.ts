export const DEFAULT_QUERY_RESULT_MAX_ROWS = 100_000;
export const MAX_QUERY_RESULT_MAX_ROWS = 2_147_483_647;

export function normalizeQueryResultMaxRows(value: unknown, fallback = DEFAULT_QUERY_RESULT_MAX_ROWS): number {
  const normalizedFallback = Number.isFinite(fallback) ? Math.min(Math.max(1, Math.floor(fallback)), MAX_QUERY_RESULT_MAX_ROWS) : DEFAULT_QUERY_RESULT_MAX_ROWS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return normalizedFallback;
  return Math.min(Math.max(1, Math.floor(parsed)), MAX_QUERY_RESULT_MAX_ROWS);
}

export function effectiveQueryResultMaxRows(enabled: boolean | undefined, value: unknown): number | undefined {
  return enabled !== false ? normalizeQueryResultMaxRows(value) : undefined;
}

export function continuousQueryResultMaxRows(enabled: boolean | undefined, value: unknown): number {
  return effectiveQueryResultMaxRows(enabled, value) ?? MAX_QUERY_RESULT_MAX_ROWS;
}

export function agentProtocolQueryResultMaxRows(maxRows: number | undefined): number {
  return maxRows ?? MAX_QUERY_RESULT_MAX_ROWS;
}

export function limitQueryPagination<T extends { limit: number; offset: number }>(pagination: T, maxRows: number | undefined): T {
  if (maxRows === undefined) return pagination;
  const requestedOffset = Math.max(0, pagination.offset);
  const offset = requestedOffset < maxRows ? requestedOffset : Math.floor((maxRows - 1) / pagination.limit) * pagination.limit;
  const remaining = maxRows - offset;
  return { ...pagination, limit: Math.min(pagination.limit, remaining), offset };
}

export function queryResultLimitReached(offset: number | undefined, rowCount: number, maxRows: number | undefined): boolean {
  return maxRows !== undefined && Math.max(0, offset ?? 0) + rowCount >= maxRows;
}

export function capQueryResultTotal(total: number, maxRows: number | undefined): number {
  return maxRows === undefined ? total : Math.min(total, maxRows);
}
