// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { safeLocalStorageGet, safeLocalStorageKeys, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

describe("safeStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("gets, sets, and removes values safely", () => {
    expect(safeLocalStorageGet("test-key")).toBeNull();
    expect(safeLocalStorageSet("test-key", "hello")).toBe(true);
    expect(safeLocalStorageGet("test-key")).toBe("hello");

    safeLocalStorageRemove("test-key");
    expect(safeLocalStorageGet("test-key")).toBeNull();
  });

  it("lists all keys via safeLocalStorageKeys", () => {
    expect(safeLocalStorageKeys()).toEqual([]);

    safeLocalStorageSet("k1", "v1");
    safeLocalStorageSet("k2", "v2");
    safeLocalStorageSet("k3", "v3");

    const keys = safeLocalStorageKeys();
    expect(keys).toHaveLength(3);
    expect(keys).toContain("k1");
    expect(keys).toContain("k2");
    expect(keys).toContain("k3");
  });
});
