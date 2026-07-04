const REDIS_GLOB_SPECIAL_CHARS = /[\\*?[\]]/g;
const REDIS_GLOB_SPECIAL_CHARS_FUZZY = /[\\*?[\]]/g;

export function escapeRedisGlobText(value: string, fuzzy = false): string {
  return value.replace(fuzzy ? REDIS_GLOB_SPECIAL_CHARS_FUZZY : REDIS_GLOB_SPECIAL_CHARS, "\\$&");
}

export function redisKeySearchPattern(value: string, fuzzy: boolean): string {
  const pattern = value.trim();
  if (!pattern) return "*";
  return fuzzy ? `*${escapeRedisGlobText(pattern, fuzzy)}*` : pattern;
}

// Redis scan page size (COUNT parameter per SCAN round-trip) — shared defaults
// and validation bounds used by the connection form and key browser.
export const REDIS_SCAN_PAGE_SIZE_DEFAULT = 1000;
export const REDIS_SCAN_PAGE_SIZE_MIN = 200;
export const REDIS_SCAN_PAGE_SIZE_MAX = 10_000;
export const REDIS_SCAN_PAGE_SIZE_OPTIONS = [200, 1000, 5000, 10_000] as const;
