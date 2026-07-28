import { test } from "vitest";
import assert from "node:assert/strict";
import { chunkRedisKeyRaws, collectUniqueRedisKeys, REDIS_DELETE_KEY_BATCH_SIZE } from "../../apps/desktop/src/lib/redis/redisKeyBatch.ts";
import type { RedisKeyInfo } from "../../apps/desktop/src/lib/backend/api.ts";

function makeKey(key: string): RedisKeyInfo {
  return { key_display: key, key_raw: key, key_type: "", ttl: -2 };
}

test("collectUniqueRedisKeys filters keys loaded by earlier batches", () => {
  const loadedKeyRaws = new Set(["existing"]);

  const keys = collectUniqueRedisKeys([makeKey("existing"), makeKey("new-1"), makeKey("new-2")], loadedKeyRaws);

  assert.deepEqual(
    keys.map((key) => key.key_raw),
    ["new-1", "new-2"],
  );
  assert.deepEqual([...loadedKeyRaws], ["existing", "new-1", "new-2"]);
});

test("collectUniqueRedisKeys filters duplicates within one batch", () => {
  const loadedKeyRaws = new Set<string>();

  const keys = collectUniqueRedisKeys([makeKey("one"), makeKey("one"), makeKey("two")], loadedKeyRaws);

  assert.deepEqual(
    keys.map((key) => key.key_raw),
    ["one", "two"],
  );
});

test("collectUniqueRedisKeys handles large batches without changing key objects", () => {
  const loadedKeyRaws = new Set<string>();
  const input = Array.from({ length: 50_000 }, (_, index) => makeKey(`key:${index}`));

  const keys = collectUniqueRedisKeys(input, loadedKeyRaws);

  assert.equal(keys.length, input.length);
  assert.equal(keys[0], input[0]);
  assert.equal(keys.at(-1), input.at(-1));
});

test("chunkRedisKeyRaws bounds large delete payloads without changing key order", () => {
  const keyRaws = Array.from({ length: REDIS_DELETE_KEY_BATCH_SIZE * 2 + 1 }, (_, index) => `key:${index}`);
  const batches = [...chunkRedisKeyRaws(keyRaws)];

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [REDIS_DELETE_KEY_BATCH_SIZE, REDIS_DELETE_KEY_BATCH_SIZE, 1],
  );
  assert.deepEqual(batches.flat(), keyRaws);
});
