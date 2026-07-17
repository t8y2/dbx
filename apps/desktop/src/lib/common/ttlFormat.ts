/**
 * Formats Redis TTL (seconds) as a compact string:
 *   < 1 day  →  HH:mm:ss
 *   >= 1 day →  {n}d HH:mm:ss  (day unit localized)
 *
 * Returns null for ttl === -1 (no expiry) or ttl <= 0.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function formatTtl(ttl: number, t: TranslateFn): string | null {
  if (ttl === -1) return null;
  if (ttl <= 0) return null;

  const days = Math.floor(ttl / 86_400);
  const hours = Math.floor((ttl % 86_400) / 3_600);
  const minutes = Math.floor((ttl % 3_600) / 60);
  const seconds = ttl % 60;

  const time = [String(hours).padStart(2, "0"), String(minutes).padStart(2, "0"), String(seconds).padStart(2, "0")].join(":");

  if (days > 0) {
    return `${t("redis.ttlDay", { count: days })} ${time}`;
  }
  return time;
}
