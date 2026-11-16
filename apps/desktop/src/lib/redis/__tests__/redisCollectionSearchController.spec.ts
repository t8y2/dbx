import { describe, expect, it, vi } from "vitest";
import type { RedisCollectionPage } from "@/lib/backend/api";
import { emptyRedisCollectionSearchState, mergeRedisCollectionItems, RedisCollectionSearchController, type RedisCollectionSearchState } from "../redisCollectionSearchController";

const scope = { connectionId: "connection", db: 0, keyRaw: "hash", kind: "hash" as const };
const blob = (text: string) => ({ raw_base64: btoa(text), encoding: "utf8" as const });
const entry = (field = "wanted", value = "value") => ({ field: blob(field), value: blob(value) });
const page = (cursor?: number, items = [] as ReturnType<typeof entry>[]): RedisCollectionPage => ({ kind: "hash", items, scan_cursor: cursor });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function setup(fetchPage = vi.fn().mockResolvedValue(page())) {
  let state: RedisCollectionSearchState = emptyRedisCollectionSearchState();
  const controller = new RedisCollectionSearchController({
    fetchPage,
    changed: (value) => {
      state = value;
    },
  });
  return {
    controller,
    fetchPage,
    state: () => state,
  };
}

describe("Redis progressive collection search", () => {
  it("restores a consumed browsing overflow page after canceling a search", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page(undefined, [entry("match")])),
    );
    const browsing = s.controller.browse(scope, [entry("original")], 17);
    await settle();
    s.controller.cancelSearch();
    s.controller.prepare(scope, "match");
    const search = s.controller.start();
    old.resolve(page(17, [entry("buffered-browse")]));
    await browsing;
    await search;
    s.controller.cancelSearch();
    await s.controller.browse(scope, [entry("original")], 17);
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
    expect(s.state().items).toEqual([entry("original"), entry("buffered-browse")]);
    expect(s.state().query).toBe("");
  });

  it("discards a retained browsing continuation when the key changes", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page(undefined, [entry("new-key")])),
    );
    const browsing = s.controller.browse(scope, [entry("original")], 17);
    await settle();
    s.controller.prepare({ ...scope, keyRaw: "new-key" }, "match");
    s.controller.cancelSearch();
    old.resolve(page(17, [entry("obsolete")]));
    await browsing;
    await s.controller.browse({ ...scope, keyRaw: "new-key" }, [], 17);
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
    expect(s.state().items).toEqual([entry("new-key")]);
  });

  it("presents results progressively and keeps scanning after a nonempty page", async () => {
    const last = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page(10))
        .mockResolvedValueOnce(page(30))
        .mockResolvedValueOnce(page(50, [entry()]))
        .mockReturnValueOnce(last.promise),
    );
    s.controller.prepare(scope, "wanted");
    const searching = s.controller.start();
    for (let i = 0; i < 4; i++) await settle();
    expect(s.fetchPage.mock.calls.map(([request]) => request.cursor)).toEqual([0, 10, 30, 50]);
    expect(s.state()).toMatchObject({ status: "searching", cursor: 50, items: [entry()] });
    last.resolve(page(undefined, [entry("later")]));
    await searching;
    expect(s.state()).toMatchObject({ status: "complete", items: [entry(), entry("later")] });
  });
  it("only marks an exhausted walk as complete", async () => {
    const s = setup(vi.fn().mockResolvedValueOnce(page(10)).mockResolvedValueOnce(page()));
    s.controller.prepare(scope, "missing");
    await s.controller.start();
    expect(s.state()).toMatchObject({ status: "complete", cursor: null, items: [] });
  });
  it("keeps displayed results unchanged across empty continuation pages", async () => {
    const empty = deferred<RedisCollectionPage>();
    const last = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page(10, [entry()]))
        .mockReturnValueOnce(empty.promise)
        .mockReturnValueOnce(last.promise),
    );
    s.controller.prepare(scope, "wanted");
    const searching = s.controller.start();
    await settle();
    const displayed = s.state().items;
    empty.resolve(page(20));
    await settle();
    expect(s.state()).toMatchObject({ status: "searching", cursor: 20 });
    expect(s.state().items).toBe(displayed);
    last.resolve(page());
    await searching;
    expect(s.state()).toMatchObject({ status: "complete", cursor: null });
    expect(s.state().items).toBe(displayed);
  });
  it("keeps scanning when a page takes longer than five seconds", async () => {
    vi.useFakeTimers();
    try {
      const s = setup(
        vi
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(page(12)), 60_000)))
          .mockResolvedValueOnce(page(undefined, [entry()])),
      );
      s.controller.prepare(scope, "wanted");
      const searching = s.controller.start();
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      await searching;
      expect(s.fetchPage.mock.calls.map(([request]) => request.cursor)).toEqual([0, 12]);
      expect(s.state()).toMatchObject({ status: "complete", items: [entry()] });
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps only the latest search while an obsolete request is in flight", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page(undefined, [entry("C")])),
    );
    s.controller.prepare(scope, "A");
    const a = s.controller.start();
    await settle();
    s.controller.prepare(scope, "B");
    const b = s.controller.start();
    s.controller.prepare(scope, "C");
    const c = s.controller.start();
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
    old.resolve(page(100, [entry("A")]));
    await Promise.all([a, b, c]);
    expect(s.fetchPage.mock.calls.map(([request]) => request.query)).toEqual(["A", "C"]);
    expect(s.state()).toMatchObject({ query: "C", items: [entry("C")] });
  });
  it("does not dispatch a new draft until explicitly submitted", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page()));
    s.controller.prepare(scope, "A");
    const a = s.controller.start();
    await settle();
    s.controller.prepare(scope, "B");
    old.resolve(page(100));
    await a;
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
    await s.controller.start();
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
  });
  it("keeps scanning a replacement search after waiting for an older request", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page(10))
        .mockResolvedValueOnce(page(undefined, [entry("C")])),
    );
    s.controller.prepare(scope, "A");
    const a = s.controller.start();
    await settle();
    s.controller.prepare(scope, "C");
    const c = s.controller.start();
    old.resolve(page(20));
    await Promise.all([a, c]);
    expect(s.fetchPage).toHaveBeenCalledTimes(3);
    expect(s.state()).toMatchObject({ status: "complete", items: [entry("C")] });
  });
  it("can stop and resume a first request without releasing its physical gate early", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page(undefined, [entry()])),
    );
    s.controller.prepare(scope, "wanted");
    const first = s.controller.start();
    await settle();
    s.controller.stop();
    expect(s.state()).toMatchObject({ status: "paused", cursor: 0 });
    const resumed = s.controller.start();
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
    old.resolve(page(99));
    await Promise.all([first, resumed]);
    expect(s.fetchPage.mock.calls[1][0].cursor).toBe(99);
    expect(s.state().status).toBe("complete");
  });
  it("keeps successful progress on failure and retries that cursor", async () => {
    const s = setup(vi.fn().mockResolvedValueOnce(page(10)).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page()));
    s.controller.prepare(scope, "wanted");
    await s.controller.start();
    expect(s.state()).toMatchObject({ status: "failed", cursor: 10 });
    await s.controller.start();
    expect(s.fetchPage.mock.calls[2][0].cursor).toBe(10);
  });
  it("retains a consumed overflow page privately while stopped and resumes without requesting it twice", async () => {
    const overflow = 2 ** 52;
    const pending = deferred<RedisCollectionPage>();
    const s = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page(overflow, [entry("first")]))
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(page(undefined, [entry("third")])),
    );
    s.controller.prepare(scope, "wanted");
    const reading = s.controller.start();
    await settle();
    s.controller.stop();
    pending.resolve(page(overflow, [entry("second")]));
    await reading;
    expect(s.state()).toMatchObject({ status: "paused", items: [entry("first")] });
    await s.controller.start();
    expect(s.fetchPage).toHaveBeenCalledTimes(3);
    expect(s.state()).toMatchObject({ status: "complete", items: [entry("first"), entry("second"), entry("third")] });
  });
  it("rejects stale errors and reset results without affecting a replacement search", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page()));
    s.controller.prepare(scope, "A");
    const a = s.controller.start();
    await settle();
    s.controller.reset();
    s.controller.prepare({ ...scope, db: 2 }, "B");
    const b = s.controller.start();
    old.reject(new Error("old failure"));
    await Promise.all([a, b]);
    expect(s.state()).toMatchObject({ query: "B", status: "complete", error: undefined });
    expect(s.fetchPage.mock.calls[1][0].scope.db).toBe(2);
  });
  it("pauses repeated empty cursors, but accepts repeated nonempty overflow cursors", async () => {
    const s = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page(10))
        .mockResolvedValueOnce(page(10))
        .mockResolvedValueOnce(page(10, [entry()]))
        .mockResolvedValueOnce(page(undefined, [entry("last")])),
    );
    s.controller.prepare(scope, "wanted");
    await s.controller.start();
    expect(s.state()).toMatchObject({ status: "paused", pauseReason: "stalled" });
    await s.controller.start();
    expect(s.state()).toMatchObject({ status: "complete", items: [entry(), entry("last")] });
  });
  it("stops on deactivation, requires manual resume on activation, and ignores disposed responses", async () => {
    const old = deferred<RedisCollectionPage>();
    const s = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page()));
    s.controller.prepare(scope, "wanted");
    const a = s.controller.start();
    await settle();
    s.controller.setActive(false);
    old.resolve(page(10));
    await a;
    s.controller.setActive(true);
    await settle();
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
    await s.controller.start();
    expect(s.state().status).toBe("complete");
    const last = deferred<RedisCollectionPage>();
    s.fetchPage.mockReturnValueOnce(last.promise);
    s.controller.prepare(scope, "last");
    const b = s.controller.start();
    await settle();
    s.controller.dispose();
    last.resolve(page(50));
    await b;
    expect(s.fetchPage).toHaveBeenCalledTimes(3);
    expect(s.state().status).toBe("paused");
  });
  it("ordinary browsing requests a single page even when that page is empty", async () => {
    const s = setup(vi.fn().mockResolvedValue(page(20)));
    await s.controller.browse(scope, [entry()], 10);
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
    expect(s.state()).toMatchObject({ status: "partial", items: [entry()], cursor: 20 });
  });
  it("merges newer values, preserves duplicate List values at distinct indices, and updates ZSet scores", () => {
    expect(mergeRedisCollectionItems("hash", [{ ...entry("field", "old"), field_ttl: 100 }], [{ ...entry("field", "new"), field_ttl: 50 }])).toEqual([{ ...entry("field", "new"), field_ttl: 50 }]);
    const value = blob("same");
    expect(mergeRedisCollectionItems("list", [{ index: 0, value }], [{ index: 1, value }])).toHaveLength(2);
    expect(mergeRedisCollectionItems("set", [{ member: value }], [{ member: value }])).toHaveLength(1);
    expect(mergeRedisCollectionItems("zset", [{ member: value, score: "1" }], [{ member: value, score: "2" }])).toEqual([{ member: value, score: "2" }]);
  });
});
