import { describe, expect, it } from "vitest";

import { computeDisplayTtl, computeTtlCountdownTick, computeTtlCountdownValue, computeTtlForExpiryEdit, DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, normalizeRedisAutoRefreshInterval } from "@/lib/redis/redisAutoRefresh";

describe("computeTtlCountdownTick", () => {
  it("returns decrement while a positive TTL remains", () => {
    expect(computeTtlCountdownTick(10)).toEqual({ type: "decrement" });
    expect(computeTtlCountdownTick(1)).toEqual({ type: "decrement" });
  });

  it("stops decrementing after the TTL has reached zero", () => {
    expect(computeTtlCountdownTick(0)).toEqual({ type: "idle" });
    expect(computeTtlCountdownTick(-1)).toEqual({ type: "idle" });
  });
});

describe("computeTtlCountdownValue", () => {
  it("accounts for time elapsed while countdown timers are paused", () => {
    expect(computeTtlCountdownValue(60, 10_000, 40_000)).toBe(30);
  });

  it("preserves Redis sentinel values and clamps expired TTLs", () => {
    expect(computeTtlCountdownValue(5, 10_000, 20_000)).toBe(0);
    expect(computeTtlCountdownValue(-1, 10_000, 20_000)).toBe(-1);
    expect(computeTtlCountdownValue(-2, 10_000, 20_000)).toBe(-2);
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
  it("returns the live countdown regardless of automatic network refresh", () => {
    expect(computeDisplayTtl(3, 10)).toBe(3);
  });

  it("does not flash back to the stale server TTL at zero", () => {
    expect(computeDisplayTtl(0, 5)).toBe(0);
  });

  it("returns live countdown while counting", () => {
    expect(computeDisplayTtl(5, 10)).toBe(5);
    expect(computeDisplayTtl(1, 10)).toBe(1);
  });

  it("clamps an active countdown below zero instead of showing stale data", () => {
    expect(computeDisplayTtl(-1, 10)).toBe(0);
  });
});

describe("computeTtlForExpiryEdit", () => {
  it("keeps a last-confirmed positive TTL during the in-flight zero-countdown window", () => {
    expect(computeTtlForExpiryEdit(0, 5)).toBe(5);
    expect(computeTtlForExpiryEdit(-1, 5)).toBe(5);
  });

  it("uses the live positive countdown and preserves non-expiring server states", () => {
    expect(computeTtlForExpiryEdit(3, 10)).toBe(3);
    expect(computeTtlForExpiryEdit(0, -1)).toBe(-1);
    expect(computeTtlForExpiryEdit(0, -2)).toBe(-2);
  });
});
