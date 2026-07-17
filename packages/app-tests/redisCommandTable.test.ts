import assert from "node:assert/strict";
import { test } from "vitest";
import { isRedisMutatingCommand, resolveRedisCommandSpec } from "../../apps/desktop/src/lib/redis/redisCommandTable.ts";

test("write commands are flagged as mutating", () => {
  assert.equal(isRedisMutatingCommand("SET foo bar"), true);
  assert.equal(isRedisMutatingCommand("DEL foo"), true);
  assert.equal(isRedisMutatingCommand("HSET h k v"), true);
  assert.equal(isRedisMutatingCommand("LPUSH list a"), true);
  assert.equal(isRedisMutatingCommand("INCR counter"), true);
  assert.equal(isRedisMutatingCommand("EXPIRE foo 60"), true);
  assert.equal(isRedisMutatingCommand("RENAME a b"), true);
});

test("subcommand mutations are detected via MAIN SUB spec", () => {
  assert.equal(isRedisMutatingCommand("XGROUP CREATE s g 0"), true);
  assert.equal(isRedisMutatingCommand("XADD stream * field value"), true);
  assert.equal(isRedisMutatingCommand("CLUSTER RESET HARD"), true);
});

test("destructive/blocked commands are flagged as mutating", () => {
  assert.equal(isRedisMutatingCommand("FLUSHDB"), true);
  assert.equal(isRedisMutatingCommand("FLUSHALL"), true);
});

test("read-only commands are not mutating", () => {
  assert.equal(isRedisMutatingCommand("GET foo"), false);
  assert.equal(isRedisMutatingCommand("LRANGE list 0 -1"), false);
  assert.equal(isRedisMutatingCommand("HGETALL h"), false);
  assert.equal(isRedisMutatingCommand("KEYS *"), false);
  assert.equal(isRedisMutatingCommand("TYPE foo"), false);
  assert.equal(isRedisMutatingCommand("SCAN 0"), false);
  assert.equal(isRedisMutatingCommand("SELECT 1"), false);
  assert.equal(isRedisMutatingCommand("INFO"), false);
});

test("read-only subcommands are not mutating", () => {
  // XLEN is a read on a stream; XINFO ... is read
  assert.equal(isRedisMutatingCommand("XLEN stream"), false);
});

test("case-insensitive and quoted command tokens", () => {
  assert.equal(isRedisMutatingCommand("set foo bar"), true);
  assert.equal(isRedisMutatingCommand("del foo"), true);
  assert.equal(isRedisMutatingCommand('get "weird key"'), false);
});

test("unknown / empty commands are treated as non-mutating (no cache thrash)", () => {
  assert.equal(isRedisMutatingCommand(""), false);
  assert.equal(isRedisMutatingCommand("NOTACMD x y"), false);
});

test("resolveRedisCommandSpec resolves subcommand then main", () => {
  const sub = resolveRedisCommandSpec(["XGROUP", "CREATE"]);
  assert.ok(sub);
  assert.equal(sub?.safety, "write");
  const main = resolveRedisCommandSpec(["GET"]);
  assert.ok(main);
  assert.equal(main?.group, "string");
});

test("normal writes do not require confirmation but destructive commands do", () => {
  assert.equal(resolveRedisCommandSpec(["SET"])?.safety, "write");
  assert.equal(resolveRedisCommandSpec(["HSET"])?.safety, "write");
  assert.equal(resolveRedisCommandSpec(["LPUSH"])?.safety, "write");
  assert.equal(resolveRedisCommandSpec(["DEL"])?.safety, "confirm");
  assert.equal(resolveRedisCommandSpec(["FLUSHDB"])?.safety, "confirm");
});
