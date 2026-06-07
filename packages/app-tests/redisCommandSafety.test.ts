import test from "node:test";
import assert from "node:assert/strict";
import { classifyRedisCommandSafety, firstRedisCommandToken } from "../../apps/desktop/src/lib/redisCommandSafety.ts";

test("firstRedisCommandToken reads the first command token case-insensitively", () => {
  assert.equal(firstRedisCommandToken("  get user:1"), "GET");
  assert.equal(firstRedisCommandToken('"set" user:1 Ada'), "SET");
});

test("classifyRedisCommandSafety separates allowed confirmed and blocked commands", () => {
  assert.equal(classifyRedisCommandSafety("GET user:1"), "allowed");
  assert.equal(classifyRedisCommandSafety("set user:1 Ada"), "confirm");
  assert.equal(classifyRedisCommandSafety("FLUSHDB"), "confirm");
  assert.equal(classifyRedisCommandSafety("KEYS *"), "blocked");
  assert.equal(classifyRedisCommandSafety("flushall"), "blocked");
  assert.equal(classifyRedisCommandSafety("eval return 1 0"), "blocked");
});
