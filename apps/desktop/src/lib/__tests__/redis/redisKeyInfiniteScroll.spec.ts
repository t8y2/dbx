import { describe, expect, it } from "vitest";

import { shouldLoadMoreRedisKeys } from "@/lib/redis/redisKeyInfiniteScroll";

const baseState = {
  enabled: true,
  hasMore: true,
  busy: false,
  loadedKeys: 1000,
  maxKeys: 5000,
  scrollTop: 800,
  clientHeight: 200,
  scrollHeight: 1050,
};

describe("shouldLoadMoreRedisKeys", () => {
  it("loads the next scan page near the bottom", () => {
    expect(shouldLoadMoreRedisKeys(baseState)).toBe(true);
  });

  it("does not load while disabled, busy, or exhausted", () => {
    expect(shouldLoadMoreRedisKeys({ ...baseState, enabled: false })).toBe(false);
    expect(shouldLoadMoreRedisKeys({ ...baseState, busy: true })).toBe(false);
    expect(shouldLoadMoreRedisKeys({ ...baseState, hasMore: false })).toBe(false);
  });

  it("stops automatic loading at the configured maximum", () => {
    expect(shouldLoadMoreRedisKeys({ ...baseState, loadedKeys: 5000 })).toBe(false);
  });

  it("does not load before reaching the bottom threshold", () => {
    expect(shouldLoadMoreRedisKeys({ ...baseState, scrollTop: 700 })).toBe(false);
  });
});
