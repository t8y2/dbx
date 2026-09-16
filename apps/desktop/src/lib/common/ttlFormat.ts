/**
 * Formats Redis TTL (seconds) as a compact human-readable remaining time:
 * 从大到小取前两个非零单位，例如：
 *   45      →  45s / 45秒
 *   3661    →  1h 1m / 1小时 1分钟
 *   93784   →  1d 2h / 1天 2小时
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

  // 按从大到小排列四个单位，只保留前两个非零单位，避免展示过长
  const units: Array<[number, string]> = [
    [days, "redis.ttlDay"],
    [hours, "redis.ttlHour"],
    [minutes, "redis.ttlMinute"],
    [seconds, "redis.ttlSecond"],
  ];

  return units
    .filter(([value]) => value > 0)
    .slice(0, 2)
    .map(([value, key]) => t(key, { count: value }))
    .join(" ");
}
