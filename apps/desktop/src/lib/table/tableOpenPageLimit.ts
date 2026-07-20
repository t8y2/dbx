import { DEFAULT_RESULT_PAGE_SIZE, normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";

export const DEFAULT_TABLE_OPEN_PAGE_LIMIT = DEFAULT_RESULT_PAGE_SIZE;

export function tableOpenPageLimit(preferredLimit?: unknown): number {
  return normalizeResultPageSize(preferredLimit, DEFAULT_TABLE_OPEN_PAGE_LIMIT);
}
