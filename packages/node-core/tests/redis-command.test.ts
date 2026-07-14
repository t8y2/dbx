import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyRedisCommand, evaluateRedisCommandSafety, firstRedisCommandToken, parseRedisCommandArgv, redisCommandDatabaseTargets, redisCommandIsMutation } from "../src/redis-command.js";

test("firstRedisCommandToken normalizes the command name", () => {
  assert.equal(firstRedisCommandToken("  get session:1"), "GET");
});

test("parseRedisCommandArgv handles quoted values and escapes", () => {
  assert.deepEqual(parseRedisCommandArgv('SET session:1 "hello world"'), ["SET", "session:1", "hello world"]);
  assert.deepEqual(parseRedisCommandArgv("SET key line\\nnext;"), ["SET", "key", "line\nnext"]);
  assert.throws(() => parseRedisCommandArgv('GET "unterminated'), /unterminated quote/);
});

test("classifyRedisCommand mirrors DBX redis command safety classes", () => {
  assert.equal(classifyRedisCommand("GET session:1"), "allowed");
  assert.equal(classifyRedisCommand("SET session:1 value"), "write");
  assert.equal(classifyRedisCommand("DEL session:1"), "confirm");
  assert.equal(classifyRedisCommand("KEYS *"), "blocked");
});

test("evaluateRedisCommandSafety blocks write commands when writes are disabled", () => {
  const decision = evaluateRedisCommandSafety("SET session:1 value", { allowWrites: false });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /read-only/i);
});

test("evaluateRedisCommandSafety requires dangerous mode for blocked commands", () => {
  const blocked = evaluateRedisCommandSafety("KEYS *", { allowWrites: true, allowDangerous: false });
  const allowed = evaluateRedisCommandSafety("KEYS *", { allowWrites: true, allowDangerous: true });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /dangerous/i);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.skipSafetyCheck, true);
});

test("production mutation classification fails closed for unknown commands", () => {
  assert.equal(redisCommandIsMutation("GET session:1"), false);
  assert.equal(redisCommandIsMutation("JSON.SET profile:1 $ {}"), true);
  assert.equal(redisCommandIsMutation("VENDOR.NEWWRITE key value"), true);
});

test("cross-database Redis commands expose every affected logical database", () => {
  assert.deepEqual(redisCommandDatabaseTargets('MOVE "session key" 7', 2), ["2", "7"]);
  assert.deepEqual(redisCommandDatabaseTargets("COPY source dest DB 8 REPLACE", 2), ["2", "8"]);
  assert.deepEqual(redisCommandDatabaseTargets("SWAPDB 3 9", 2), ["2", "3", "9"]);
  assert.deepEqual(redisCommandDatabaseTargets("FLUSHALL", 2, ["7", "8"]), ["2", "7", "8"]);
});
