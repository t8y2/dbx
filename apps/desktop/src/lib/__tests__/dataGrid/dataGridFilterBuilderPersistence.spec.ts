import { beforeEach, describe, expect, it } from "vitest";
import { loadDataGridStructuredFilterState, saveDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

describe("data grid structured filter persistence", () => {
  const cacheKey = "issue-436-filter-view";
  const scopeKey = "mysql\0demo\0users";

  beforeEach(() => {
    saveDataGridStructuredFilterState(cacheKey, {
      scopeKey,
      manualWhereInput: "tenant_id = 7",
      rules: [{ id: "r1", columnName: "status", mode: "equals", rawValue: "open", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "status = 'open'",
      serverColumnFilters: {},
    });
  });

  it("restores the filter rules and manual condition", () => {
    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)).toMatchObject({
      manualWhereInput: "tenant_id = 7",
      rules: [{ columnName: "status", rawValue: "open" }],
    });
  });

  it("does not leak filters into another table scope", () => {
    expect(loadDataGridStructuredFilterState(cacheKey, `${scopeKey}\0archive`)).toBeUndefined();
  });

  it("returns cloned state without mutating the cache", () => {
    const restored = loadDataGridStructuredFilterState(cacheKey, scopeKey)!;
    restored.rules[0].rawValue = "closed";
    restored.serverColumnFilters[0] = { condition: "\"status\" = 'closed'", keys: ["closed"], labels: ["closed"] };

    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)).toMatchObject({
      rules: [{ rawValue: "open" }],
      serverColumnFilters: {},
    });
  });
});
