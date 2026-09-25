import { describe, expect, it } from "vitest";
import { compileRedisGroupGlob, compileRedisKeyGroups, defaultRedisKeyGrouping, validateRedisKeyGrouping } from "../redisKeyGrouping";
import { RedisKeyGroupIndex } from "../redisKeyGroupIndex";
import type { RedisKeyInfo } from "@/lib/backend/api";

const raw = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
const key = (name: string): RedisKeyInfo => ({ key_raw: raw(name), key_display: name, key_type: "string", ttl: -1, size: 1 });
const rule = { id: "suffix", name: "Metadata", enabled: true, includes: ["*:redisson_options"], excludes: [] };
const work = { current: () => true, yield: async () => {} };

describe("Redis grouping contracts", () => {
  it("is opt-in and rejects malformed edits", () => {
    expect(validateRedisKeyGrouping(defaultRedisKeyGrouping()).enabled).toBe(false);
    expect(() => validateRedisKeyGrouping({ ...defaultRedisKeyGrouping(), rules: [{ ...rule, includes: [] }] })).toThrow();
    expect(() => validateRedisKeyGrouping({ ...defaultRedisKeyGrouping(), rules: [rule, rule] })).toThrow();
    expect(() => validateRedisKeyGrouping({ ...defaultRedisKeyGrouping(), version: 2 })).toThrow();
  });
  it("uses whole-byte glob semantics, escapes and ranges", () => {
    const matches = (pattern: string, text: string) => compileRedisGroupGlob(pattern)(new TextEncoder().encode(text));
    expect(matches("?", "中")).toBe(false);
    expect(matches("???", "中")).toBe(true);
    expect(matches("[z-a]", "q")).toBe(true);
    expect(matches("[^a]", "b")).toBe(true);
    expect(matches("a\\*", "a*")).toBe(true);
    expect(matches("a", "ab")).toBe(false);
    expect(matches("*", "")).toBe(true);
    expect(matches("**", "")).toBe(false);
    expect(compileRedisGroupGlob("?")(new Uint8Array([255]))).toBe(true);
    expect(matches("*a*a*a*a*a*b", "a".repeat(10000))).toBe(false);
  });
  it("uses first match and exclusion veto without lossy display text", () => {
    const classify = compileRedisKeyGroups([rule, { ...rule, id: "business", includes: [], excludes: ["private:*"] }]);
    expect(classify(raw("cache:redisson_options"))).toBe("suffix");
    expect(classify(raw("cache:one"))).toBe("business");
    expect(classify(raw("private:one"))).toBe(null);
    expect(compileRedisKeyGroups([{ ...rule, includes: ["?"], enabled: false }])("/w==")).toBe(null);
  });
  it("deduplicates append and exposes immutable-length range snapshots", async () => {
    const index = new RedisKeyGroupIndex([rule], "Other");
    const first = [key("a:redisson_options"), key("b")];
    await index.append(first, work);
    const expanded = new Set(['custom:"suffix"', "custom:unmatched"]);
    const before = (await index.project("list", ":", expanded, work))!;
    expect(before.rows.map((row) => row.kind)).toEqual(["virtual-group", "key", "virtual-group", "key"]);
    await index.append([...first, first[0]!, key("c")], work);
    expect(before.rows.length).toBe(4);
    const after = (await index.project("list", ":", expanded, work))!;
    expect(after.rows.length).toBe(5);
    expect(after.positions.get(`key:${raw("c")}`)).toBe(4);
  });
  it("scopes namespace IDs by outer group and never produces legacy group nodes", async () => {
    const index = new RedisKeyGroupIndex([rule], "Other");
    await index.append([key("a:redisson_options"), key("a:other")], work);
    const result = (await index.project("tree", ":", new Set(['custom:"suffix"', "custom:unmatched"]), work))!;
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(result.rows.length);
    expect(result.rows.every((row) => row.kind === "virtual-group")).toBe(true);
    const expanded = new Set(result.rows.map((row) => row.id));
    const leaves = (await index.project("tree", ":", expanded, work))!;
    expect(leaves.rows.filter((row) => row.kind === "key")).toHaveLength(2);
  });
  it("cancels bounded work and resumes append without duplicates", async () => {
    const index = new RedisKeyGroupIndex([], "Other");
    const keys = Array.from({ length: 2000 }, (_, i) => key(String(i)));
    let alive = true;
    expect(
      await index.append(keys, {
        current: () => alive,
        yield: async () => {
          alive = false;
        },
      }),
    ).toBe(false);
    await index.append(keys, work);
    const result = (await index.project("list", ":", new Set(["custom:unmatched"]), work))!;
    expect(result.rows.length).toBe(2001);
  });
  it("does not materialize each loaded key again when projecting a large list", async () => {
    const index = new RedisKeyGroupIndex([], "Other");
    await index.append(
      Array.from({ length: 100000 }, (_, i) => key(String(i))),
      work,
    );
    let yields = 0;
    const result = (await index.project("list", ":", new Set(["custom:unmatched"]), {
      current: () => true,
      yield: async () => {
        yields++;
      },
    }))!;
    expect(yields).toBe(0);
    expect(result.rows.length).toBe(100001);
    expect(result.positions.get(`key:${raw("99999")}`)).toBe(100000);
  });
});
