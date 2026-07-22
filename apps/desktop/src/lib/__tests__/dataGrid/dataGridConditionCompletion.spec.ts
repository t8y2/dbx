import { describe, expect, it } from "vitest";
import { dataGridConditionColumnOptions } from "@/lib/dataGrid/dataGridConditionCompletion";

describe("dataGridConditionColumnOptions", () => {
  it("reuses PostgreSQL completion quoting while preserving display metadata", () => {
    expect(dataGridConditionColumnOptions([{ name: "OrderId", comment: "Mixed case" }, { name: "order", comment: null }, { name: "article", comment: "Safe identifier" }, { name: 'has"quote' }], "postgres")).toEqual([
      { name: "OrderId", comment: "Mixed case", insertText: '"OrderId"' },
      { name: "order", comment: null, insertText: '"order"' },
      { name: "article", comment: "Safe identifier", insertText: "article" },
      { name: 'has"quote', insertText: '"has""quote"' },
    ]);
  });

  it.each(["mysql", "sqlserver", "oracle"] as const)("keeps existing %s condition insertions unchanged", (databaseType) => {
    expect(dataGridConditionColumnOptions(["OrderId", "order"], databaseType)).toEqual([
      { name: "OrderId", insertText: "OrderId" },
      { name: "order", insertText: "order" },
    ]);
  });
});
