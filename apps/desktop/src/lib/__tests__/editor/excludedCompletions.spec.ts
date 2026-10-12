import { describe, expect, it } from "vitest";
import { excludedCompletionLabelSet, filterExcludedCompletions, normalizeExcludedCompletionItems } from "@/lib/editor/excludedCompletions";

describe("excluded completion items", () => {
  it("normalizes entries from arrays or line/comma separated text", () => {
    expect(normalizeExcludedCompletionItems([" WIDTH_BUCKET ", "", "get_lock", "GET_LOCK", 42, null])).toEqual(["WIDTH_BUCKET", "get_lock"]);
    expect(normalizeExcludedCompletionItems("WIDTH_BUCKET, get_lock\nWIDTH_BUCKET")).toEqual(["WIDTH_BUCKET", "get_lock"]);
    expect(normalizeExcludedCompletionItems(undefined)).toEqual([]);
    expect(normalizeExcludedCompletionItems({})).toEqual([]);
  });

  it("filters excluded labels case-insensitively but keeps batch selection actions", () => {
    const excluded = excludedCompletionLabelSet(["width_bucket"]);
    const items = [
      { label: "WIDTH_BUCKET", type: "function" as const },
      { label: "when", type: "keyword" as const },
      { label: "users", type: "table" as const, batchColumnSelectionAction: true },
    ];
    expect(filterExcludedCompletions(items, excluded).map((item) => item.label)).toEqual(["when", "users"]);
    expect(filterExcludedCompletions(items, new Set())).toEqual(items);
  });
});
