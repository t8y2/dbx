import { describe, expect, it } from "vitest";
import { buildDataGridColumnLookupItems, filterDataGridColumnLookupItems } from "@/lib/dataGrid/dataGridColumnLookup";

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
