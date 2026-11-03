/**
 * The key browser fills the TYPE badge and the expiry countdown of the rows
 * it lists. A scan can ask the server for that metadata inline, which costs
 * two commands per key, so the sweep only does it for a bounded number of
 * keys and the rest is resolved afterwards.
 */

/**
 * Keys one sweep round trip asks Redis for.
 *
 * The sweep uses large key-only SCAN pages and rebuilds the tree once at the
 * end; the per-page tree sorting dominates the runtime on million-key pattern
 * scans.
 */
export const REDIS_FETCH_ALL_SCAN_COUNT = 50_000;

/**
 * Keys a single sweep may pay for inline TYPE/TTL metadata.
 *
 * The sweep asks Redis for COUNT = REDIS_FETCH_ALL_SCAN_COUNT keys per round
 * trip, so one batch already costs at most 2 * REDIS_FETCH_ALL_SCAN_COUNT
 * commands. The budget keeps a whole sweep at that order of magnitude no
 * matter how large the keyspace is: the keys beyond it are listed by name and
 * their badges are filled in afterwards, for the rows the user actually looks
 * at.
 *
 * The budget is the page size because the first batch of a sweep is inlined
 * unconditionally: a smaller budget would only mean the sweep pays for more
 * than the budget allows.
 */
export const REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS = REDIS_FETCH_ALL_SCAN_COUNT;

/**
 * Whether the sweep may keep asking for inline TYPE/TTL metadata.
 *
 * `inlineKeys` counts the keys the sweep already asked the server about, so
 * the decision never depends on a DBSIZE that may be stale, may be missing
 * (kvrocks only counts asynchronously) or that describes the whole database
 * instead of the filtered scope being swept.
 */
export function redisFetchAllShouldInlineMetadata(inlineKeys: number, budget = REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS): boolean {
  return inlineKeys < budget;
}

/**
 * Keys that may wait for their metadata.
 *
 * The visible window can queue faster than the backend answers, so the queue
 * is capped: it holds the rows the user is looking at, not every key of a
 * million-key database.
 */
export const REDIS_METADATA_BACKFILL_QUEUE_LIMIT = 5_000;

/**
 * Drops the oldest queued keys once the queue grows past its limit.
 *
 * The oldest entries belong to the rows the user scrolled past; their badges
 * are filled in again when they are listed anew. The queue keeps its
 * insertion order, so the first key is the oldest one.
 */
export function trimRedisMetadataBackfillQueue(queue: Set<string>, limit = REDIS_METADATA_BACKFILL_QUEUE_LIMIT): void {
  while (queue.size > limit) {
    const oldest = queue.values().next().value;
    if (oldest === undefined) break;
    queue.delete(oldest);
  }
}
