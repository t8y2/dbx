import { describe, expect, it } from "vitest";

import { computeAutoRefreshTick, computeDisplayTtl, computeTtlForExpiryEdit, DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, normalizeRedisAutoRefreshInterval } from "@/lib/redis/redisAutoRefresh";

describe("computeAutoRefreshTick", () => {
  it("returns idle when auto-refresh is disabled", () => {
    expect(computeAutoRefreshTick(false, 10)).toEqual({ type: "idle" });
    expect(computeAutoRefreshTick(false, 0)).toEqual({ type: "idle" });
    expect(computeAutoRefreshTick(false, 5)).toEqual({ type: "idle" });
  });

  it("returns decrement while a positive TTL remains", () => {
    expect(computeAutoRefreshTick(true, 10)).toEqual({ type: "decrement" });
    expect(computeAutoRefreshTick(true, 1)).toEqual({ type: "decrement" });
  });

  it("stops decrementing after the TTL has reached zero", () => {
    expect(computeAutoRefreshTick(true, 0)).toEqual({ type: "idle" });
    expect(computeAutoRefreshTick(true, -1)).toEqual({ type: "idle" });
  });
});

describe("normalizeRedisAutoRefreshInterval", () => {
  it("uses the default for invalid values and clamps arbitrary input to safe seconds", () => {
    expect(normalizeRedisAutoRefreshInterval("invalid")).toBe(DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS);
    expect(normalizeRedisAutoRefreshInterval(0)).toBe(1);
    expect(normalizeRedisAutoRefreshInterval(1.9)).toBe(1);
    expect(normalizeRedisAutoRefreshInterval(9_999)).toBe(3600);
  });
});

describe("computeDisplayTtl", () => {
  it("returns server TTL when auto-refresh is disabled", () => {
    expect(computeDisplayTtl(false, 3, 10)).toBe(10);
  });

  it("does not flash back to the stale server TTL at zero", () => {
    expect(computeDisplayTtl(true, 0, 5)).toBe(0);
  });

  it("returns live countdown when auto-refresh is active and counting", () => {
    expect(computeDisplayTtl(true, 5, 10)).toBe(5);
    expect(computeDisplayTtl(true, 1, 10)).toBe(1);
  });

  it("clamps an active countdown below zero instead of showing stale data", () => {
    expect(computeDisplayTtl(true, -1, 10)).toBe(0);
  });
});

describe("computeTtlForExpiryEdit", () => {
  it("keeps a last-confirmed positive TTL during the in-flight zero-countdown window", () => {
    expect(computeTtlForExpiryEdit(true, 0, 5)).toBe(5);
    expect(computeTtlForExpiryEdit(true, -1, 5)).toBe(5);
  });

  it("uses the live positive countdown and preserves non-expiring server states", () => {
    expect(computeTtlForExpiryEdit(true, 3, 10)).toBe(3);
    expect(computeTtlForExpiryEdit(false, 3, 10)).toBe(10);
    expect(computeTtlForExpiryEdit(true, 0, -1)).toBe(-1);
    expect(computeTtlForExpiryEdit(true, 0, -2)).toBe(-2);
  });
});
