import { describe, expect, it } from "vitest";
import { clearRedisKeyBrowserState, restoreRedisKeyBrowserState, saveRedisKeyBrowserState, type RedisKeyBrowserStateSnapshot } from "@/lib/tabs/redisKeyBrowserStateCache";

function snapshot(suffix: number): RedisKeyBrowserStateSnapshot {
  return {
    searchPattern: `user:${suffix}*`,
    searchMode: suffix % 2 === 0 ? "key" : "value",
    fuzzyKeySearch: suffix % 3 === 0,
    noExpiryOnly: suffix % 2 === 1,
  };
}

describe("redisKeyBrowserStateCache", () => {
  it("round-trips a snapshot for the same key", () => {
    saveRedisKeyBrowserState("round-trip", snapshot(3));

    expect(restoreRedisKeyBrowserState("round-trip")).toEqual(snapshot(3));
  });

  it("returns undefined for an unknown key", () => {
    expect(restoreRedisKeyBrowserState("missing")).toBeUndefined();
  });

  it("keeps the most recent write for a key", () => {
    saveRedisKeyBrowserState("overwrite", snapshot(1));
    saveRedisKeyBrowserState("overwrite", snapshot(2));

    expect(restoreRedisKeyBrowserState("overwrite")).toEqual(snapshot(2));
  });

  it("evicts the oldest entry beyond 32 keys", () => {
    for (let index = 0; index < 33; index += 1) {
      saveRedisKeyBrowserState(`evict-${index}`, snapshot(index));
    }

    expect(restoreRedisKeyBrowserState("evict-0")).toBeUndefined();
    expect(restoreRedisKeyBrowserState("evict-1")).toBeDefined();
    expect(restoreRedisKeyBrowserState("evict-32")).toBeDefined();
  });

  it("treats a restore as recency so a touched entry survives eviction", () => {
    for (let index = 0; index < 32; index += 1) {
      saveRedisKeyBrowserState(`touch-${index}`, snapshot(index));
    }
    expect(restoreRedisKeyBrowserState("touch-0")).toEqual(snapshot(0));
    saveRedisKeyBrowserState("touch-new", snapshot(99));

    expect(restoreRedisKeyBrowserState("touch-0")).toBeDefined();
    expect(restoreRedisKeyBrowserState("touch-1")).toBeUndefined();
  });

  it("clears a key on demand", () => {
    saveRedisKeyBrowserState("clear-me", snapshot(4));
    clearRedisKeyBrowserState("clear-me");

    expect(restoreRedisKeyBrowserState("clear-me")).toBeUndefined();
  });
});
