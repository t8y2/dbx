import type { CalendarDateTime } from "@internationalized/date";
import { calendarDateTimeToUnixSeconds } from "@/components/ui/date-time-picker/dateTimePicker";

export type RedisExpiryMode = "none" | "ttl" | "at";

export type RedisExpiryPolicy = { mode: "none" } | { mode: "ttl"; ttl: number } | { mode: "at"; expireAt: number };

export type RedisExpiryValidation = { valid: true; policy: RedisExpiryPolicy } | { valid: false; reason: "ttl" | "date" | "past" };

export interface RedisExpiryTransport {
  setTtl: (connectionId: string, db: number, keyRaw: string, ttl: number) => Promise<void>;
  setExpireAt: (connectionId: string, db: number, keyRaw: string, expireAt: number) => Promise<void>;
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
