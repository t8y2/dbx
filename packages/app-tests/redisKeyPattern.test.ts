import assert from "node:assert/strict";
import test from "node:test";
import { escapeRedisGlobText, redisKeySearchPattern } from "../../apps/desktop/src/lib/redisKeyPattern.ts";

test("builds Redis key fuzzy search patterns from plain text", () => {
  assert.equal(redisKeySearchPattern("", true), "*");
  assert.equal(redisKeySearchPattern(" user ", true), "*user*");
});

test("escapes Redis glob characters in fuzzy key search", () => {
  assert.equal(escapeRedisGlobText(String.raw`user:*?[1]`), String.raw`user:\*\?\[1\]`);
  assert.equal(redisKeySearchPattern(String.raw`user:*?[1]`, true), String.raw`*user:\*\?\[1\]*`);
});

test("keeps Redis key pattern syntax when fuzzy search is off", () => {
  assert.equal(redisKeySearchPattern("user:*", false), "user:*");
});
