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

/**
 * SCAN MATCH pattern covering exactly the subtree of a tree group: every
 * segment is glob-escaped so keys containing `*`/`?`/`[`/`]` match literally,
 * and the trailing `*` only widens to the group's descendants.
 */
export function redisGroupSubtreePattern(pathSegments: readonly string[], separator = ":"): string {
  const prefix = pathSegments.map((segment) => escapeRedisGlobText(segment)).join(separator);
  return `${prefix}${separator}*`;
}

// Fuzzy key search has to walk the Redis keyspace because MATCH has no index.
// Start conservatively, then use DBSIZE to cover ordinary databases while
// retaining a hard upper bound for unusually large instances.
export const REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET = 50_000;
export const REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX = 1_000_000;

export function redisFuzzySearchScanBudget(totalKeys: number): number {
  const normalizedTotalKeys = Number.isFinite(totalKeys) ? Math.max(0, Math.floor(totalKeys)) : 0;
  return Math.min(Math.max(REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET, normalizedTotalKeys), REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX);
}

// Redis scan page size (COUNT parameter per SCAN round-trip) — shared defaults
// and validation bounds used by the connection form and key browser.
export const REDIS_SCAN_PAGE_SIZE_DEFAULT = 1000;
export const REDIS_SCAN_PAGE_SIZE_MIN = 200;
export const REDIS_SCAN_PAGE_SIZE_MAX = 10_000;
export const REDIS_SCAN_PAGE_SIZE_OPTIONS = [200, 1000, 2000, 5000, 10_000] as const;
