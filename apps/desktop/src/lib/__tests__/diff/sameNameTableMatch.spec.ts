import { describe, expect, it } from "vitest";
import { buildSameNameTableMatches } from "@/lib/diff/sameNameTableMatch";

describe("buildSameNameTableMatches", () => {
  it("matches same-name target tables and reports missing ones", () => {
    const result = buildSameNameTableMatches(["a", "b", "c"], ["a", "c", "d"]);
    expect(result).toEqual({ matched: ["a", "c"], missing: ["b"] });
  });

  it("reports all missing when no target tables exist", () => {
    const result = buildSameNameTableMatches(["x", "y"], []);
    expect(result).toEqual({ matched: [], missing: ["x", "y"] });
  });

  it("has no missing when every source matches", () => {
    const result = buildSameNameTableMatches(["a", "b"], ["b", "a"]);
    expect(result).toEqual({ matched: ["a", "b"], missing: [] });
  });

  it("handles empty source set", () => {
    const result = buildSameNameTableMatches([], ["a"]);
    expect(result).toEqual({ matched: [], missing: [] });
  });
});
