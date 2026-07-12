import { describe, expect, it } from "vitest";

import { computeAutoRefreshTick, computeDisplayTtl, shouldStopAutoRefresh } from "@/lib/redis/redisAutoRefresh";

describe("computeAutoRefreshTick", () => {
  it("returns idle when auto-refresh is disabled", () => {
    expect(computeAutoRefreshTick(false, 10, false)).toEqual({ type: "idle" });
    // countdown value and loading flag don't matter when disabled
    expect(computeAutoRefreshTick(false, 0, false)).toEqual({ type: "idle" });
    expect(computeAutoRefreshTick(false, 5, true)).toEqual({ type: "idle" });
  });

  it("returns decrement while more than one second remains", () => {
    expect(computeAutoRefreshTick(true, 10, false)).toEqual({ type: "decrement" });
    // decrement even when loading — countdown should keep ticking
    expect(computeAutoRefreshTick(true, 3, true)).toEqual({ type: "decrement" });
  });

  it("refreshes on the expiry tick instead of exposing a zero countdown", () => {
    expect(computeAutoRefreshTick(true, 1, false)).toEqual({ type: "refresh" });
    expect(computeAutoRefreshTick(true, 0, false)).toEqual({ type: "refresh" });
    expect(computeAutoRefreshTick(true, -1, false)).toEqual({ type: "refresh" });
  });

  it("does not start another refresh when a load is already in flight", () => {
    expect(computeAutoRefreshTick(true, 1, true)).toEqual({ type: "decrement" });
    // This prevents concurrent load() calls
    expect(computeAutoRefreshTick(true, 0, true)).toEqual({ type: "idle" });
    expect(computeAutoRefreshTick(true, -1, true)).toEqual({ type: "idle" });
  });
});

describe("shouldStopAutoRefresh", () => {
  it("returns true when TTL is zero (key expired)", () => {
    expect(shouldStopAutoRefresh(0)).toBe(true);
  });

  it("returns true when TTL is negative (no expiry or key deleted)", () => {
    expect(shouldStopAutoRefresh(-1)).toBe(true);
    expect(shouldStopAutoRefresh(-2)).toBe(true);
  });

  it("returns false when TTL is positive (key still alive)", () => {
    expect(shouldStopAutoRefresh(1)).toBe(false);
    expect(shouldStopAutoRefresh(3600)).toBe(false);
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
