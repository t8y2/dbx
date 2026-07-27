import { describe, expect, it } from "vitest";
import { filterKvKeysBySearch, kvKeyMatchesSearch } from "@/lib/kv/kvKeySearch";

describe("KV Key path search", () => {
  it("matches the query anywhere in the complete Key path", () => {
    const keys = ["/a/b/c", "/dbx/a", "/test/a", "/test/c", "a", "aaa", "bb"].map((key) => ({ key }));

    expect(filterKvKeysBySearch(keys, "a").map((key) => key.key)).toEqual(["/a/b/c", "/dbx/a", "/test/a", "a", "aaa"]);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(kvKeyMatchesSearch("/Apps/Production/Name", " production ")).toBe(true);
    expect(kvKeyMatchesSearch("/Apps/Production/Name", "staging")).toBe(false);
  });
});
