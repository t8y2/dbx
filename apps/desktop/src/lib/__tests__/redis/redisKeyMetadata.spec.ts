import { describe, expect, it } from "vitest";
import { REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS, REDIS_FETCH_ALL_SCAN_COUNT, REDIS_METADATA_BACKFILL_QUEUE_LIMIT, redisFetchAllShouldInlineMetadata, trimRedisMetadataBackfillQueue } from "@/lib/redis/redisKeyMetadata";

describe("Redis key metadata budget", () => {
  it("keeps the metadata inline while the sweep stays inside the budget", () => {
    expect(redisFetchAllShouldInlineMetadata(0)).toBe(true);
    expect(redisFetchAllShouldInlineMetadata(REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS - 1)).toBe(true);
  });

  it("stops the inline metadata once the budget is used up", () => {
    expect(redisFetchAllShouldInlineMetadata(REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS)).toBe(false);
    expect(redisFetchAllShouldInlineMetadata(REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS + 1)).toBe(false);
  });

  it("matches the scan batch size so one batch cannot blow the budget up", () => {
    // The sweep asks Redis for COUNT = REDIS_FETCH_ALL_SCAN_COUNT keys per
    // round trip, so a single batch is the largest unit the budget has to
    // absorb: the first batch of a sweep is inlined unconditionally.
    expect(REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS).toBe(REDIS_FETCH_ALL_SCAN_COUNT);
    expect(REDIS_FETCH_ALL_SCAN_COUNT).toBe(50_000);
  });
});

describe("Redis key metadata backfill queue", () => {
  it("keeps the queue within its limit and drops the oldest keys first", () => {
    const queue = new Set<string>();
    for (let index = 0; index < REDIS_METADATA_BACKFILL_QUEUE_LIMIT + 10; index++) queue.add(`key:${index}`);

    trimRedisMetadataBackfillQueue(queue);

    expect(queue.size).toBe(REDIS_METADATA_BACKFILL_QUEUE_LIMIT);
    // The oldest entries are the ones that go: they belong to the rows the
    // user scrolled past.
    expect(queue.has("key:0")).toBe(false);
    expect(queue.has(`key:${REDIS_METADATA_BACKFILL_QUEUE_LIMIT + 9}`)).toBe(true);
  });

  it("leaves a queue that fits untouched", () => {
    const queue = new Set(["a", "b"]);

    trimRedisMetadataBackfillQueue(queue);

    expect([...queue]).toEqual(["a", "b"]);
  });
});
