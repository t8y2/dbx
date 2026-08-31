import { beforeEach, describe, expect, it } from "vitest";
import { clearDataGridStructuredFilterStatesForTab, loadDataGridStructuredFilterState, saveDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

describe("data grid structured filter persistence", () => {
  const cacheKey = "issue-436-filter-view";
  const scopeKey = "mysql\0demo\0users";

  beforeEach(() => {
    clearDataGridStructuredFilterStatesForTab("issue-436-filter-view");
    clearDataGridStructuredFilterStatesForTab("lru-tab");
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

  it("clears every result-grid state owned by a closed tab", () => {
    saveDataGridStructuredFilterState("tab-1-run-1-0", {
      scopeKey,
      manualWhereInput: "id > 1",
      rules: [],
      appliedWhereInput: "id > 1",
      serverColumnFilters: {},
    });
    saveDataGridStructuredFilterState("tab-10-run-1-0", {
      scopeKey,
      manualWhereInput: "id > 10",
      rules: [],
      appliedWhereInput: "id > 10",
      serverColumnFilters: {},
    });

    clearDataGridStructuredFilterStatesForTab("tab-1");

    expect(loadDataGridStructuredFilterState("tab-1-run-1-0", scopeKey)).toBeUndefined();
    expect(loadDataGridStructuredFilterState("tab-10-run-1-0", scopeKey)?.manualWhereInput).toBe("id > 10");
    clearDataGridStructuredFilterStatesForTab("tab-10");
  });

  it("bounds cached result-grid states and refreshes recency on read", () => {
    const state = {
      scopeKey,
      manualWhereInput: "",
      rules: [],
      appliedWhereInput: "",
      serverColumnFilters: {},
    };
    for (let index = 0; index < 128; index += 1) saveDataGridStructuredFilterState(`lru-tab-${index}`, state);
    expect(loadDataGridStructuredFilterState("lru-tab-0", scopeKey)).toBeDefined();

    saveDataGridStructuredFilterState("lru-tab-128", state);

    expect(loadDataGridStructuredFilterState("lru-tab-0", scopeKey)).toBeDefined();
    expect(loadDataGridStructuredFilterState("lru-tab-1", scopeKey)).toBeUndefined();
  });
});
