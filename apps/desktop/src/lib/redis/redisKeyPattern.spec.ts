import { describe, expect, it } from "vitest";
import { redisGroupSubtreePattern } from "@/lib/redis/redisKeyPattern";

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
