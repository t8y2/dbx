import { describe, expect, it } from "vitest";
import { buildDataGridColumnLookupItems, dataGridColumnCommentFor, filterDataGridColumnLookupItems } from "@/lib/dataGrid/dataGridColumnLookup";

describe("data grid column comment lookup", () => {
  it("resolves comments through the physical source column before the result label", () => {
    const comments = new Map([
      ["minx", "Minimum X coordinate"],
      ["MINX", "Result label comment"],
    ]);

    expect(dataGridColumnCommentFor(comments, "MINX", "minx")).toBe("Minimum X coordinate");
  });

  it("falls back past blank source comments and case-normalizes result labels", () => {
    const comments = new Map([
      ["physical_name", "   "],
      ["result_name", "Result comment"],
    ]);

    expect(dataGridColumnCommentFor(comments, "RESULT_NAME", "physical_name")).toBe("Result comment");
  });
});

describe("data grid column lookup search", () => {
  const items = buildDataGridColumnLookupItems({
    columns: ["userProfile", "order_id", "created_at"],
  });

  it("matches camel-case initials", () => {
    expect(filterDataGridColumnLookupItems(items, "up").map((item) => item.name)).toEqual(["userProfile"]);
  });

  it("matches text from any position", () => {
    expect(filterDataGridColumnLookupItems(items, "id").map((item) => item.name)).toEqual(["order_id"]);
  });

  it("returns all columns for an empty query", () => {
    expect(filterDataGridColumnLookupItems(items, " ")).toEqual(items);
  });
});
