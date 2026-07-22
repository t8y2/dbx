import type { RedisKeyInfo } from "@/lib/backend/api";

export function collectUniqueRedisKeys(keys: RedisKeyInfo[], loadedKeyRaws: Set<string>): RedisKeyInfo[] {
  const uniqueKeys: RedisKeyInfo[] = [];

  for (const key of keys) {
    if (loadedKeyRaws.has(key.key_raw)) continue;
    loadedKeyRaws.add(key.key_raw);
    uniqueKeys.push(key);
  }

  return uniqueKeys;
}
