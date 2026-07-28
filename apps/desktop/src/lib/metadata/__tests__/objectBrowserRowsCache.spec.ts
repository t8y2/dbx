import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import { cacheObjectBrowserRows, clearObjectBrowserRowsCache, getCachedObjectBrowserRows, invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";

const row: ObjectBrowserRow = {
  id: "table:users",
  name: "users",
  displayName: "users",
  type: "TABLE",
};

describe("objectBrowserRowsCache", () => {
  beforeEach(() => clearObjectBrowserRowsCache());
  afterEach(() => vi.useRealTimers());

  it("restores cached rows only for the same object browser scope", () => {
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheObjectBrowserRows(scope, [row]);

    expect(getCachedObjectBrowserRows(scope)).toEqual([row]);
    expect(getCachedObjectBrowserRows({ ...scope, schema: "archive" })).toBeUndefined();
    expect(getCachedObjectBrowserRows({ ...scope, connectionId: "c2" })).toBeUndefined();
  });

  it("returns copies so component updates do not mutate the cached rows", () => {
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheObjectBrowserRows(scope, [row]);

    const cached = getCachedObjectBrowserRows(scope)!;
    cached[0].displayName = "changed";

    expect(getCachedObjectBrowserRows(scope)?.[0].displayName).toBe("users");
  });

  it("restores fresh rows when a remounted component reads the shared cache", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheObjectBrowserRows(scope, [row]);

    expect(getCachedObjectBrowserRows(scope)).toEqual([row]);
  });

  it("rejects cached rows after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheObjectBrowserRows(scope, [row]);

    vi.advanceTimersByTime(30_001);
    expect(getCachedObjectBrowserRows(scope)).toBeUndefined();
  });

  it("invalidates matching connection and database scopes", () => {
    const first = { connectionId: "c1", database: "db1", schema: "public" };
    const second = { connectionId: "c1", database: "db2", schema: "public" };
    const third = { connectionId: "c2", database: "db1", schema: "public" };
    cacheObjectBrowserRows(first, [row]);
    cacheObjectBrowserRows(second, [row]);
    cacheObjectBrowserRows(third, [row]);

    expect(invalidateObjectBrowserRowsCache({ connectionId: "c1", database: "db1" })).toBe(1);
    expect(getCachedObjectBrowserRows(first)).toBeUndefined();
    expect(getCachedObjectBrowserRows(second)).toEqual([row]);
    expect(getCachedObjectBrowserRows(third)).toEqual([row]);
  });
});
