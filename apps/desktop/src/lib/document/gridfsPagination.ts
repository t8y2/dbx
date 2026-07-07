import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";

export function gridFsTotalPages(totalCount: number, pageSize: number): number {
  const normalizedPageSize = Math.max(1, normalizeResultPageSize(pageSize));
  const normalizedTotal = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;
  return Math.max(1, Math.ceil(normalizedTotal / normalizedPageSize));
}

export function clampGridFsPage(page: number, totalCount: number, pageSize: number): number {
  const lastPage = gridFsTotalPages(totalCount, pageSize) - 1;
  if (!Number.isFinite(page)) return 0;
  return Math.max(0, Math.min(Math.floor(page), lastPage));
}

export function paginateGridFsItems<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const normalizedPageSize = Math.max(1, normalizeResultPageSize(pageSize));
  const safePage = clampGridFsPage(page, items.length, normalizedPageSize);
  const start = safePage * normalizedPageSize;
  return items.slice(start, start + normalizedPageSize);
}
