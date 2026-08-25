import { describe, expect, it } from "vitest";
import { filterRedisKeyTemplates, normalizeRedisKeyTemplates, redisKeyTemplatesToTextarea, resolveRedisKeyTemplates } from "@/lib/redis/redisKeyTemplates";

describe("redisKeyTemplates", () => {
  it("normalizes arrays and newline text, trimming and deduping", () => {
    expect(normalizeRedisKeyTemplates(["  user:{$id}  ", "", "v3:adui:{$positionID}", "user:{$id}", "  "])).toEqual(["user:{$id}", "v3:adui:{$positionID}"]);

    expect(normalizeRedisKeyTemplates("user:{$id}\n\nv3:adui\nuser:{$id}\n")).toEqual(["user:{$id}", "v3:adui"]);
    expect(normalizeRedisKeyTemplates(null)).toEqual([]);
    expect(normalizeRedisKeyTemplates(undefined)).toEqual([]);
    expect(normalizeRedisKeyTemplates([1, "ok"] as unknown[])).toEqual(["ok"]);
  });

  it("resolves connection templates over global when connection list is non-empty", () => {
    expect(resolveRedisKeyTemplates(["conn:a"], ["global:a", "global:b"])).toEqual(["conn:a"]);
    expect(resolveRedisKeyTemplates([], ["global:a"])).toEqual(["global:a"]);
    expect(resolveRedisKeyTemplates(undefined, ["global:a"])).toEqual(["global:a"]);
    expect(resolveRedisKeyTemplates(["  ", ""], ["global:a"])).toEqual(["global:a"]);
    expect(resolveRedisKeyTemplates(undefined, undefined)).toEqual([]);
  });

  it("filters by case-insensitive substring and returns all when query is blank", () => {
    const templates = ["v3:adui:{$positionID}", "v4:adui:creative_feed:{$arg1}", "cache:session"];
    expect(filterRedisKeyTemplates(templates, "")).toEqual(templates);
    expect(filterRedisKeyTemplates(templates, "  ")).toEqual(templates);
    expect(filterRedisKeyTemplates(templates, "ADUI")).toEqual(["v3:adui:{$positionID}", "v4:adui:creative_feed:{$arg1}"]);
    expect(filterRedisKeyTemplates(templates, "session")).toEqual(["cache:session"]);
    expect(filterRedisKeyTemplates(templates, "missing")).toEqual([]);
  });

  it("joins templates for textarea editing", () => {
    expect(redisKeyTemplatesToTextarea(["a", "b"])).toBe("a\nb");
    expect(redisKeyTemplatesToTextarea(undefined)).toBe("");
  });
});
