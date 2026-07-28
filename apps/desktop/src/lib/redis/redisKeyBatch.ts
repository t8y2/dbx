import type { RedisKeyInfo } from "@/lib/backend/api";

// Keep desktop IPC and Redis command payloads bounded for large group deletes.
export const REDIS_DELETE_KEY_BATCH_SIZE = 1_000;

export function collectUniqueRedisKeys(keys: RedisKeyInfo[], loadedKeyRaws: Set<string>): RedisKeyInfo[] {
  const uniqueKeys: RedisKeyInfo[] = [];

  for (const key of keys) {
    if (loadedKeyRaws.has(key.key_raw)) continue;
    loadedKeyRaws.add(key.key_raw);
    uniqueKeys.push(key);
  }

  return uniqueKeys;
}

export function* chunkRedisKeyRaws(keyRaws: readonly string[], batchSize = REDIS_DELETE_KEY_BATCH_SIZE): Generator<string[]> {
  for (let start = 0; start < keyRaws.length; start += batchSize) {
    yield keyRaws.slice(start, start + batchSize);
  }
}
