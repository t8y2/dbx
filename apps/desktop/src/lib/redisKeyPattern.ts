const REDIS_GLOB_SPECIAL_CHARS = /[\\*?[\]]/g;
const REDIS_GLOB_SPECIAL_CHARS_FUZZY = /[\\*?[\]]/g;

export function escapeRedisGlobText(value: string, fuzzy = false): string {
  return value.replace(fuzzy ? REDIS_GLOB_SPECIAL_CHARS_FUZZY : REDIS_GLOB_SPECIAL_CHARS, "\\$&");
}

export function redisKeySearchPattern(value: string, fuzzy: boolean): string {
  const pattern = value.trim();
  if (!pattern) return "*";
  return fuzzy ? `*${escapeRedisGlobText(pattern, fuzzy)}*` : pattern;
}
