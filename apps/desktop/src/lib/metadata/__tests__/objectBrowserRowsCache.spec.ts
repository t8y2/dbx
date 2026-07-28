import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import { cacheObjectBrowserRows, clearObjectBrowserRowsCache, createObjectBrowserRowsCacheWriteToken, getCachedObjectBrowserRows, invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";

const row: ObjectBrowserRow = {
  id: "table:users",
  name: "users",
  displayName: "users",
  type: "TABLE",
};

function cacheRows(scope: Parameters<typeof createObjectBrowserRowsCacheWriteToken>[0], rows: readonly ObjectBrowserRow[] = [row]) {
  return cacheObjectBrowserRows(createObjectBrowserRowsCacheWriteToken(scope), rows);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("objectBrowserRowsCache", () => {
  beforeEach(() => clearObjectBrowserRowsCache());
  afterEach(() => vi.useRealTimers());

  it("restores cached rows only for the same object browser scope", () => {
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheRows(scope);

    expect(getCachedObjectBrowserRows(scope)).toEqual([row]);
    expect(getCachedObjectBrowserRows({ ...scope, schema: "archive" })).toBeUndefined();
    expect(getCachedObjectBrowserRows({ ...scope, connectionId: "c2" })).toBeUndefined();
  });

  it("returns copies so component updates do not mutate the cached rows", () => {
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheRows(scope);

    const cached = getCachedObjectBrowserRows(scope)!;
    cached[0].displayName = "changed";

    expect(getCachedObjectBrowserRows(scope)?.[0].displayName).toBe("users");
  });

  it("restores fresh rows when a remounted component reads the shared cache", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheRows(scope);

    expect(getCachedObjectBrowserRows(scope)).toEqual([row]);
  });

  it("rejects cached rows after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheRows(scope);

    vi.advanceTimersByTime(30_001);
    expect(getCachedObjectBrowserRows(scope)).toBeUndefined();
  });

  it("invalidates matching connection and database scopes", () => {
    const first = { connectionId: "c1", database: "db1", schema: "public" };
    const second = { connectionId: "c1", database: "db2", schema: "public" };
    const third = { connectionId: "c2", database: "db1", schema: "public" };
    cacheRows(first);
    cacheRows(second);
    cacheRows(third);

    expect(invalidateObjectBrowserRowsCache({ connectionId: "c1", database: "db1" })).toBe(1);
    expect(getCachedObjectBrowserRows(first)).toBeUndefined();
    expect(getCachedObjectBrowserRows(second)).toEqual([row]);
    expect(getCachedObjectBrowserRows(third)).toEqual([row]);
  });

  it("rejects a late cache write started before matching metadata invalidation", async () => {
    const invalidatedScope = { connectionId: "c1", database: "db1", schema: "public" };
    const isolatedScope = { connectionId: "c1", database: "db2", schema: "public" };
    const invalidatedToken = createObjectBrowserRowsCacheWriteToken(invalidatedScope);
    const isolatedToken = createObjectBrowserRowsCacheWriteToken(isolatedScope);
    const pendingRows = deferred<readonly ObjectBrowserRow[]>();
    const lateWrite = pendingRows.promise.then((rows) => cacheObjectBrowserRows(invalidatedToken, rows));

    invalidateObjectBrowserRowsCache({ connectionId: "c1", database: "db1", schema: "public" });
    pendingRows.resolve([row]);

    expect(await lateWrite).toBeUndefined();
    expect(cacheObjectBrowserRows(isolatedToken, [row])).toEqual(expect.any(Number));
    expect(getCachedObjectBrowserRows(invalidatedScope)).toBeUndefined();
    expect(getCachedObjectBrowserRows(isolatedScope)).toEqual([row]);
  });

  it("preserves the original object list freshness when statistics update cached rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    const token = createObjectBrowserRowsCacheWriteToken(scope);
    const fetchedAt = cacheObjectBrowserRows(token, [row]);

    vi.advanceTimersByTime(29_000);
    cacheObjectBrowserRows(token, [{ ...row, estimatedRows: 42 }], { cachedAt: fetchedAt });
    expect(getCachedObjectBrowserRows(scope)?.[0].estimatedRows).toBe(42);

    vi.advanceTimersByTime(1_001);
    expect(getCachedObjectBrowserRows(scope)).toBeUndefined();
  });

  it("projects table invalidation onto the object list cache scope", () => {
    const scope = { connectionId: "c1", database: "db", schema: "public" };
    cacheRows(scope, [{ ...row, estimatedRows: 42 }]);

    expect(invalidateObjectBrowserRowsCache({ ...scope, tableName: "users" })).toBe(1);
    expect(getCachedObjectBrowserRows(scope)).toBeUndefined();
  });
});
