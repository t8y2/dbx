export const CONSUL_LIST_PAGE_SIZE = 50;

export function consulPageCount(total: number, pageSize = CONSUL_LIST_PAGE_SIZE): number {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safePageSize = Math.max(1, Math.trunc(pageSize));
  return Math.max(1, Math.ceil(safeTotal / safePageSize));
}

export function clampConsulPage(page: number, total: number, pageSize = CONSUL_LIST_PAGE_SIZE): number {
  const safePage = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(1, safePage), consulPageCount(total, pageSize));
}

export function paginateConsulItems<T>(items: readonly T[], page: number, pageSize = CONSUL_LIST_PAGE_SIZE): T[] {
  const safePageSize = Math.max(1, Math.trunc(pageSize));
  const safePage = clampConsulPage(page, items.length, safePageSize);
  const start = (safePage - 1) * safePageSize;
  return items.slice(start, start + safePageSize);
}
