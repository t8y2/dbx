import { describe, expect, it } from "vitest";
import { dedupeResultColumnNames } from "@/lib/sql/resultColumnNames";

describe("dedupeResultColumnNames", () => {
  it("renames repeated labels with numeric suffixes", () => {
    expect(dedupeResultColumnNames(["id", "name", "name", "name"])).toEqual(["id", "name", "name_1", "name_2"]);
  });

  it("never collides with a label that already uses the suffix", () => {
    expect(dedupeResultColumnNames(["name", "name_1", "name", "name"])).toEqual(["name", "name_1", "name_2", "name_3"]);
  });

  it("keeps unique and empty labels untouched", () => {
    expect(dedupeResultColumnNames(["", "a", "b"])).toEqual(["", "a", "b"]);
    expect(dedupeResultColumnNames([])).toEqual([]);
  });
});
