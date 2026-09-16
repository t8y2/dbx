import { describe, expect, it } from "vitest";
import { createRedisKeyPatternMatcher, redisGroupSubtreePattern, redisKeyMatchesPattern } from "@/lib/redis/redisKeyPattern";

describe("redisGroupSubtreePattern", () => {
  it("builds a prefix pattern for single and nested groups", () => {
    expect(redisGroupSubtreePattern(["grp"])).toBe("grp:*");
    expect(redisGroupSubtreePattern(["grp", "sub"])).toBe("grp:sub:*");
  });

  it("supports custom separators and preserves empty segments", () => {
    expect(redisGroupSubtreePattern(["a", "b"], "/")).toBe("a/b/*");
    expect(redisGroupSubtreePattern(["a", "", "c"])).toBe("a::c:*");
  });

  it("escapes glob metacharacters in every segment", () => {
    expect(redisGroupSubtreePattern(["a*b"])).toBe("a\\*b:*");
    expect(redisGroupSubtreePattern(["order?]", "x[y"])).toBe("order\\?\\]:x\\[y:*");
    expect(redisGroupSubtreePattern(["back\\slash"])).toBe("back\\\\slash:*");
  });
});

describe("redisKeyMatchesPattern", () => {
  it.each([
    ["[z-a]", "m", true],
    ["[a", "a", true],
    ["[]", "]", false],
    ["?", "中", false],
    ["???", "中", true],
    ["????", "😀", true],
    ["[^x]", "y", true],
    ["*中*", "key:中文", true],
    ["literal:\\*", "literal:x", false],
  ])("matches Redis byte-based glob semantics for %s", (pattern, value, expected) => {
    expect(redisKeyMatchesPattern(value, pattern)).toBe(expected);
  });

  it("uses raw bytes when Redis escapes a display key", () => {
    const literalSlash = createRedisKeyPatternMatcher("path\\\\name");
    expect(literalSlash("path\\\\name", btoa("path\\name"))).toBe(true);
    expect(createRedisKeyPatternMatcher("bin:?")("bin:\\xff", btoa("bin:\xff"))).toBe(true);
    expect(createRedisKeyPatternMatcher("bin:?")("bin:\\xff", "invalid!")).toBe(false);
  });

  it("reuses a compiled matcher without carrying state between keys", () => {
    const matches = createRedisKeyPatternMatcher("*login*");
    expect(["session:1", "prod:login:1", "session:2", "prod:login:2"].filter((value) => matches(value))).toEqual(["prod:login:1", "prod:login:2"]);
  });

  it("matches Redis glob literals, wildcards, and classes", () => {
    expect(redisKeyMatchesPattern("prod:login_fail_count", "prod:login_fail_count")).toBe(true);
    expect(redisKeyMatchesPattern("prod:login_fail_count", "prod:*_fail_????t")).toBe(true);
    expect(redisKeyMatchesPattern("prod:login_fail_count", "prod:[a-z]*")).toBe(true);
    expect(redisKeyMatchesPattern("prod:LOGIN_FAIL_COUNT", "prod:[a-z]*")).toBe(false);
  });

  it("treats escaped glob characters as literals", () => {
    expect(redisKeyMatchesPattern("literal:*", "literal:\\*")).toBe(true);
    expect(redisKeyMatchesPattern("literal:x", "literal:\\*")).toBe(false);
  });
});
