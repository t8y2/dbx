import { describe, expect, it } from "vitest";
import { redisFuzzySearchScanBudget, REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX, REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET, REDIS_SCAN_PAGE_SIZE_DEFAULT, REDIS_SCAN_PAGE_SIZE_OPTIONS } from "@/lib/redis/redisKeyPattern";

describe("Redis key search settings", () => {
  it("keeps the default scan count conservative for initial loading", () => {
    expect(REDIS_SCAN_PAGE_SIZE_DEFAULT).toBe(1000);
    expect(REDIS_SCAN_PAGE_SIZE_OPTIONS).toContain(2000);
  });

  it("covers the reported keyspace while retaining a large-instance cap", () => {
    expect(redisFuzzySearchScanBudget(0)).toBe(REDIS_KEY_SEARCH_SCAN_COUNT_BUDGET);
    expect(redisFuzzySearchScanBudget(378543)).toBe(378543);
    expect(redisFuzzySearchScanBudget(REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX + 1)).toBe(REDIS_FUZZY_SEARCH_SCAN_COUNT_MAX);
  });
});
