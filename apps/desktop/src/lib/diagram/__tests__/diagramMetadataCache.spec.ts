import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFocusedDiagramCacheForTests, DIAGRAM_METADATA_CACHE_TTL_MS, focusedDiagramCacheKey, getFocusedDiagramCache, invalidateFocusedDiagramCache, loadFocusedDiagramCached, setFocusedDiagramCache } from "../diagramMetadataCache";
import type { DiagramTable } from "../erDiagram";

const tables = (name = "A"): DiagramTable[] => [{ name, schema: "public", columns: [], foreignKeys: [], indexes: [] }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  clearFocusedDiagramCacheForTests();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("five minute closure cache", () => {
  it("loads once within TTL and expires exactly at five minutes", async () => {
    const loader = vi.fn(async () => tables());
    await loadFocusedDiagramCached("key", loader);
    vi.advanceTimersByTime(DIAGRAM_METADATA_CACHE_TTL_MS - 1);
    await loadFocusedDiagramCached("key", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await loadFocusedDiagramCached("key", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent callers and gives each a separate snapshot", async () => {
    const pending = deferred<DiagramTable[]>();
    const loader = vi.fn(() => pending.promise);
    const a = loadFocusedDiagramCached("key", loader);
    const b = loadFocusedDiagramCached("key", loader);
    pending.resolve(tables());
    const [first, second] = await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
    first[0].name = "edited";
    expect(second[0].name).toBe("A");
    expect(getFocusedDiagramCache("key")?.[0].name).toBe("A");
  });

  it("clones on storing and reading, including nested metadata", () => {
    const original = tables();
    setFocusedDiagramCache("key", original);
    original[0].name = "changed";
    const read = getFocusedDiagramCache("key")!;
    read[0].foreignKeys.push({ name: "fk" } as never);
    expect(getFocusedDiagramCache("key")).toEqual(tables());
  });

  it("does not cache errors and retries the next call", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(tables());
    await expect(loadFocusedDiagramCached("key", loader)).rejects.toThrow("offline");
    expect(getFocusedDiagramCache("key")).toBeUndefined();
    await loadFocusedDiagramCached("key", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("force bypasses cache, joins forced loads, and replaces only after success", async () => {
    setFocusedDiagramCache("key", tables("old"));
    const pending = deferred<DiagramTable[]>();
    const loader = vi.fn(() => pending.promise);
    const a = loadFocusedDiagramCached("key", loader, { force: true });
    const b = loadFocusedDiagramCached("key", loader, { force: true });
    expect(await loadFocusedDiagramCached("key", loader)).toEqual(tables("old"));
    pending.resolve(tables("fresh"));
    await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getFocusedDiagramCache("key")).toEqual(tables("fresh"));
  });

  it("preserves valid cache after failed forced refresh", async () => {
    setFocusedDiagramCache("key", tables("old"));
    await expect(
      loadFocusedDiagramCached(
        "key",
        async () => {
          throw new Error("offline");
        },
        { force: true },
      ),
    ).rejects.toThrow("offline");
    expect(getFocusedDiagramCache("key")).toEqual(tables("old"));
  });

  it("an older ordinary load cannot overwrite a newer forced result", async () => {
    const pending = deferred<DiagramTable[]>();
    const old = loadFocusedDiagramCached("key", () => pending.promise);
    await loadFocusedDiagramCached("key", async () => tables("fresh"), { force: true });
    pending.resolve(tables("old"));
    await old;
    expect(getFocusedDiagramCache("key")).toEqual(tables("fresh"));
  });

  it("invalidating in-flight work prevents later cache commits", async () => {
    const pending = deferred<DiagramTable[]>();
    const load = loadFocusedDiagramCached("key", () => pending.promise);
    invalidateFocusedDiagramCache();
    pending.resolve(tables());
    await load;
    expect(getFocusedDiagramCache("key")).toBeUndefined();
  });

  it("keys isolate connection, database, catalog, schemas, names, and root sets", () => {
    const base = {
      connectionId: "c",
      database: "db",
      roots: [
        { schema: "public", name: "A" },
        { schema: "public", name: "B" },
      ],
    };
    const key = focusedDiagramCacheKey(base);
    expect(focusedDiagramCacheKey({ ...base, roots: [...base.roots].reverse().concat(base.roots) })).toBe(key);
    for (const change of [{ connectionId: "other" }, { database: "other" }, { catalog: "other" }, { roots: [{ schema: "other", name: "A" }] }, { roots: [base.roots[0]] }, { roots: [{ schema: "public", name: "a" }] }]) {
      expect(focusedDiagramCacheKey({ ...base, ...change })).not.toBe(key);
    }
    expect(focusedDiagramCacheKey({ ...base, roots: [{ schema: "a.b", name: "c" }] })).not.toBe(focusedDiagramCacheKey({ ...base, roots: [{ schema: "a", name: "b.c" }] }));
  });
});
