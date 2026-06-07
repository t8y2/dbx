export const RESULT_PAGE_SIZE_OPTIONS = [50, 100, 500, 1000];
export const DEFAULT_RESULT_PAGE_SIZE = 100;
export const MIN_RESULT_PAGE_SIZE = 1;
export const MAX_RESULT_PAGE_SIZE = 100000;

export function normalizeResultPageSize(value: unknown, fallback = DEFAULT_RESULT_PAGE_SIZE): number {
  const fallbackValue =
    Number.isFinite(fallback) && fallback >= MIN_RESULT_PAGE_SIZE
      ? Math.min(Math.floor(fallback), MAX_RESULT_PAGE_SIZE)
      : DEFAULT_RESULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  const rounded = Math.floor(parsed);
  if (rounded < MIN_RESULT_PAGE_SIZE) return fallbackValue;
  return Math.min(rounded, MAX_RESULT_PAGE_SIZE);
}

export function resultPageSizeMenuOptions(current: number): number[] {
  return [...new Set([...RESULT_PAGE_SIZE_OPTIONS, normalizeResultPageSize(current)])].sort((a, b) => a - b);
}
