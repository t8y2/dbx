import type { CalendarDateTime } from "@internationalized/date";
import { calendarDateTimeToUnixSeconds } from "@/components/ui/date-time-picker/dateTimePicker";
import type { RedisKeysExpiryResult } from "@/lib/backend/api";
import { REDIS_KEY_MUTATION_BATCH_SIZE, chunkRedisKeyRaws } from "@/lib/redis/redisKeyBatch";

export type RedisExpiryMode = "none" | "ttl" | "at";

export type RedisExpiryPolicy = { mode: "none" } | { mode: "ttl"; ttl: number } | { mode: "at"; expireAt: number };

export type RedisExpiryValidation = { valid: true; policy: RedisExpiryPolicy } | { valid: false; reason: "ttl" | "date" | "past" };

export interface RedisExpiryTransport {
  setTtl: (connectionId: string, db: number, keyRaw: string, ttl: number) => Promise<void>;
  setExpireAt: (connectionId: string, db: number, keyRaw: string, expireAt: number) => Promise<void>;
}

/**
 * Batch counterpart of {@link RedisExpiryTransport}. One call covers a bounded
 * chunk of keys, so a large selection never becomes one request per key.
 */
export interface RedisBatchExpiryTransport {
  setKeysTtl: (connectionId: string, db: number, keyRaws: string[], ttl: number) => Promise<RedisKeysExpiryResult>;
  setKeysExpireAt: (connectionId: string, db: number, keyRaws: string[], expireAt: number) => Promise<RedisKeysExpiryResult>;
}

/** Per-key outcome of a batch expiration, aggregated across every chunk. */
export interface RedisBatchExpirySummary {
  /** Keys the server confirmed as updated. */
  applied: number;
  /** Keys that were not updated, so the caller can keep them selected for a retry. */
  failedKeyRaws: string[];
  /** Transport failures, one per chunk that never returned per-key results. */
  errors: string[];
}

/** Parse the EXPIRE argument without accepting partial, negative, or unsafe values. */
export function parseRedisTtl(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;

  const ttl = Number(trimmed);
  return Number.isSafeInteger(ttl) ? ttl : null;
}

export function redisExpiryModeForTtl(ttl: number): RedisExpiryMode {
  return ttl > 0 ? "ttl" : "none";
}

export function validateRedisExpiry(mode: RedisExpiryMode, ttlInput: string, expireAt: CalendarDateTime | null, now = Date.now()): RedisExpiryValidation {
  if (mode === "none") return { valid: true, policy: { mode } };

  if (mode === "ttl") {
    const ttl = parseRedisTtl(ttlInput);
    return ttl === null ? { valid: false, reason: "ttl" } : { valid: true, policy: { mode, ttl } };
  }

  if (!expireAt) return { valid: false, reason: "date" };
  let timestamp: number;
  try {
    timestamp = calendarDateTimeToUnixSeconds(expireAt);
  } catch {
    return { valid: false, reason: "date" };
  }
  return timestamp * 1_000 <= now ? { valid: false, reason: "past" } : { valid: true, policy: { mode, expireAt: timestamp } };
}

/** Applies exactly one post-write Redis expiration command for a validated policy. */
export async function applyRedisExpiryPolicy(transport: RedisExpiryTransport, connectionId: string, db: number, keyRaw: string, policy: RedisExpiryPolicy): Promise<void> {
  if (policy.mode === "none") {
    await transport.setTtl(connectionId, db, keyRaw, -1);
    return;
  }
  if (policy.mode === "ttl") {
    await transport.setTtl(connectionId, db, keyRaw, policy.ttl);
    return;
  }
  await transport.setExpireAt(connectionId, db, keyRaw, policy.expireAt);
}

/**
 * Applies one validated policy to every selected key through the batch transport.
 *
 * Chunking keeps a 1000-key selection to a bounded number of requests, and a
 * chunk that fails outright keeps the keys an earlier chunk already updated
 * instead of discarding the whole result. Each chunk uses the same PERSIST /
 * EXPIRE / EXPIREAT shape as {@link applyRedisExpiryPolicy}.
 */
export async function applyRedisBatchExpiryPolicy(transport: RedisBatchExpiryTransport, connectionId: string, db: number, keyRaws: readonly string[], policy: RedisExpiryPolicy, batchSize = REDIS_KEY_MUTATION_BATCH_SIZE): Promise<RedisBatchExpirySummary> {
  const summary: RedisBatchExpirySummary = { applied: 0, failedKeyRaws: [], errors: [] };
  const uniqueKeyRaws = [...new Set(keyRaws)];
  if (uniqueKeyRaws.length === 0) return summary;

  for (const batch of chunkRedisKeyRaws(uniqueKeyRaws, batchSize)) {
    try {
      const result = policy.mode === "at" ? await transport.setKeysExpireAt(connectionId, db, batch, policy.expireAt) : await transport.setKeysTtl(connectionId, db, batch, policy.mode === "ttl" ? policy.ttl : -1);
      summary.applied += result.applied;
      summary.failedKeyRaws.push(...result.missing_key_raws);
    } catch (error) {
      summary.failedKeyRaws.push(...batch);
      summary.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}
