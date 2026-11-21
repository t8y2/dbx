export const REDIS_VALUE_PREVIEW_LIMIT_KIB_DEFAULT = 64;
export const REDIS_VALUE_PREVIEW_LIMIT_KIB_MIN = 1;
export const REDIS_VALUE_PREVIEW_LIMIT_KIB_MAX = 65_536;
export const REDIS_VALUE_PREVIEW_LIMIT_KIB_OPTIONS = [64, 256, 1024, 4096, 16_384, 65_536] as const;

export function normalizeRedisValuePreviewLimitKiB(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return REDIS_VALUE_PREVIEW_LIMIT_KIB_DEFAULT;
  return Math.min(REDIS_VALUE_PREVIEW_LIMIT_KIB_MAX, Math.max(REDIS_VALUE_PREVIEW_LIMIT_KIB_MIN, Math.round(value)));
}

export function redisValuePreviewLimitBytes(value: unknown): number {
  return normalizeRedisValuePreviewLimitKiB(value) * 1024;
}
