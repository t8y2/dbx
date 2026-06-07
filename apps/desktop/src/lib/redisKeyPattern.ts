const REDIS_GLOB_SPECIAL_CHARS = /[\\*?[\]]/g;

export function escapeRedisGlobText(value: string): string {
  return value.replace(REDIS_GLOB_SPECIAL_CHARS, "\\$&");
}

export function redisKeySearchPattern(value: string, fuzzy: boolean): string {
  const pattern = value.trim();
  if (!pattern) return "*";
  return fuzzy ? `*${escapeRedisGlobText(pattern)}*` : pattern;
}
