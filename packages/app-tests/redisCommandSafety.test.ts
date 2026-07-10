import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyRedisCommandSafety } from "../../apps/desktop/src/lib/redis/redisCommandSafety.ts";

test("classifies normal Redis writes separately from destructive commands", () => {
  assert.equal(classifyRedisCommandSafety("SET session:1 value"), "write");
  assert.equal(classifyRedisCommandSafety("HSET hash field value"), "write");
  assert.equal(classifyRedisCommandSafety("LPUSH queue value"), "write");
  assert.equal(classifyRedisCommandSafety("DEL session:1"), "confirm");
  assert.equal(classifyRedisCommandSafety("FLUSHDB"), "confirm");
  assert.equal(classifyRedisCommandSafety("KEYS *"), "blocked");
  assert.equal(classifyRedisCommandSafety("GET session:1"), "allowed");
});
