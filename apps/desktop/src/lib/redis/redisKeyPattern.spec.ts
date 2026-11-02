import { describe, expect, it } from "vitest";
import { createRedisKeyPatternMatcher, escapeRedisGlobText, redisGroupSubtreePattern, redisKeyMatchesPattern, redisKeySearchPattern } from "@/lib/redis/redisKeyPattern";

describe("redisKeySearchPattern", () => {
  it("returns `*` for empty input regardless of fuzzy", () => {
    expect(redisKeySearchPattern("", false)).toBe("*");
    expect(redisKeySearchPattern("   ", true)).toBe("*");
  });

  it("non-fuzzy (pattern) mode returns the trimmed value verbatim", () => {
    expect(redisKeySearchPattern("user:*", false)).toBe("user:*");
    expect(redisKeySearchPattern("  prod:login_fail_count:* ", false)).toBe("prod:login_fail_count:*");
  });

  it("fuzzy mode wraps plain text as `*text*` for substring-contains matching", () => {
    expect(redisKeySearchPattern("admin", true)).toBe("*admin*");
    expect(redisKeySearchPattern("login_fail_count", true)).toBe("*login_fail_count*");
  });

  it("fuzzy mode keeps user `*` as a wildcard so explicit globs still match (#9012)", () => {
    // `prod:login_fail_count:*` must NOT escape the `*` to `\*`; the key
    // prod:login_fail_count:admin:2026-09-14 must be findable.
    expect(redisKeySearchPattern("prod:login_fail_count:*", true)).toBe("*prod:login_fail_count:**");
    expect(redisKeySearchPattern("prod:login_fail_count:admin:2026*", true)).toBe("*prod:login_fail_count:admin:2026**");
    // A bare `2026*` becomes `*2026**` (substring contains, wildcard honoured).
    expect(redisKeySearchPattern("2026*", true)).toBe("*2026**");
  });

  it("fuzzy mode keeps `?` as a single-char wildcard", () => {
    expect(redisKeySearchPattern("user:?", true)).toBe("*user:?*");
  });

  it("fuzzy mode still escapes `[` / `]` / `\\` to avoid char-class / escape ambiguity", () => {
    expect(redisKeySearchPattern("a[b", true)).toBe("*a\\[b*");
    expect(redisKeySearchPattern("a]b", true)).toBe("*a\\]b*");
    expect(redisKeySearchPattern("a\\b", true)).toBe("*a\\\\b*");
  });
});

describe("escapeRedisGlobText", () => {
  it("non-fuzzy (default) escapes the full glob metacharacter set", () => {
    expect(escapeRedisGlobText("a*b")).toBe("a\\*b");
    expect(escapeRedisGlobText("a?b")).toBe("a\\?b");
    expect(escapeRedisGlobText("a[b")).toBe("a\\[b");
    expect(escapeRedisGlobText("a]b")).toBe("a\\]b");
    expect(escapeRedisGlobText("a\\b")).toBe("a\\\\b");
  });

  it("fuzzy escapes only `[` / `]` / `\\`, leaving `*` / `?` as wildcards", () => {
    expect(escapeRedisGlobText("a*b", true)).toBe("a*b");
    expect(escapeRedisGlobText("a?b", true)).toBe("a?b");
    expect(escapeRedisGlobText("a[b", true)).toBe("a\\[b");
    expect(escapeRedisGlobText("a]b", true)).toBe("a\\]b");
    expect(escapeRedisGlobText("a\\b", true)).toBe("a\\\\b");
  });
});

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
