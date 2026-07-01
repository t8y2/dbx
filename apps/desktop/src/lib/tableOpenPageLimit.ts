import { DEFAULT_RESULT_PAGE_SIZE, normalizeResultPageSize } from "@/lib/paginationPageSize";

export const DEFAULT_TABLE_OPEN_PAGE_LIMIT = DEFAULT_RESULT_PAGE_SIZE;

export function tableOpenPageLimit(): number {
  // Opening a table should not inherit the mutable SQL result-grid rows-per-page setting.
  return normalizeResultPageSize(DEFAULT_TABLE_OPEN_PAGE_LIMIT);
}
