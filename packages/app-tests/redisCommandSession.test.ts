import assert from "node:assert/strict";
import { test } from "vitest";
import { isRedisClearScreenCommand, nextRedisCommandDb, redisKeyTextToRaw } from "../../apps/desktop/src/lib/redisCommandSession.ts";

test("keeps Redis command session database after SELECT succeeds", () => {
  assert.equal(nextRedisCommandDb(3, "SELECT 0", "OK"), 0);
  assert.equal(nextRedisCommandDb(0, "select 12", "OK"), 12);
});

test("does not change Redis command session database for failed or non-select commands", () => {
  assert.equal(nextRedisCommandDb(3, "SELECT nope", "OK"), 3);
  assert.equal(nextRedisCommandDb(3, "SELECT 2", "ERR invalid DB index"), 3);
  assert.equal(nextRedisCommandDb(3, "HGET farmer:1 balance", "42"), 3);
});

test("recognizes local Redis terminal clear commands", () => {
  assert.equal(isRedisClearScreenCommand("clear"), true);
  assert.equal(isRedisClearScreenCommand(" CLEAR "), true);
  assert.equal(isRedisClearScreenCommand("cls"), true);
  assert.equal(isRedisClearScreenCommand("clear key"), false);
  assert.equal(isRedisClearScreenCommand("DEL clear"), false);
});

test("encodes Redis key text as the raw base64 transport value", () => {
  assert.equal(redisKeyTextToRaw("user:1"), "dXNlcjox");
  assert.equal(redisKeyTextToRaw("用户:配置"), "55So5oi3OumFjee9rg==");
});
