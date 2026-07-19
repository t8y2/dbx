import { describe, expect, it } from "vitest";
import { loadDataGridStructuredFilterState, saveDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

describe("data grid filter builder persistence", () => {
  it("isolates scopes and returns cloned state", () => {
    saveDataGridStructuredFilterState("cache", {
      scopeKey: "scope-a",
      manualWhereInput: "status = 1",
      rules: [{ id: "rule-1", columnName: "status", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: '"status" = 1',
      serverColumnFilters: { 0: { condition: '"status" = 1', keys: ["1"], labels: ["1"] } },
    });

    expect(loadDataGridStructuredFilterState("cache", "scope-b")).toBeUndefined();
    const restored = loadDataGridStructuredFilterState("cache", "scope-a")!;
    restored.rules[0].rawValue = "2";
    restored.serverColumnFilters[0].keys.push("2");

    expect(loadDataGridStructuredFilterState("cache", "scope-a")).toMatchObject({
      rules: [{ rawValue: "1" }],
      serverColumnFilters: { 0: { keys: ["1"] } },
    });
  });
});
