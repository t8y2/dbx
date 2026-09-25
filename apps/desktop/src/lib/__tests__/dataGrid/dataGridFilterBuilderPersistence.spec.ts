/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from "vitest";
import { clearDataGridStructuredFilterStates, clearDataGridStructuredFilterStatesForTab, dropDataGridStructuredFilterMemoryCache, loadDataGridStructuredFilterState, saveDataGridStructuredFilterState } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

describe("data grid structured filter persistence", () => {
  const cacheKey = "issue-436-filter-view";
  const scopeKey = "mysql\0demo\0users";

  beforeEach(() => {
    clearDataGridStructuredFilterStates();
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

  it("restores visual filter rules after a process restart instead of the combined WHERE (#8831)", () => {
    saveDataGridStructuredFilterState("data-tab-orders", {
      scopeKey,
      manualWhereInput: "",
      rules: [{ id: "r-id", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "`id` = 1",
      serverColumnFilters: {},
    });

    dropDataGridStructuredFilterMemoryCache();

    const restored = loadDataGridStructuredFilterState("data-tab-orders", scopeKey);
    expect(restored).toMatchObject({
      manualWhereInput: "",
      appliedWhereInput: "`id` = 1",
      rules: [{ columnName: "id", mode: "equals", rawValue: "1" }],
    });
  });

  it("keeps a closed tab's filters off disk after restart", () => {
    saveDataGridStructuredFilterState("tab-1-run-1-0", {
      scopeKey,
      manualWhereInput: "id > 1",
      rules: [],
      appliedWhereInput: "id > 1",
      serverColumnFilters: {},
    });
    clearDataGridStructuredFilterStatesForTab("tab-1");
    dropDataGridStructuredFilterMemoryCache();

    expect(loadDataGridStructuredFilterState("tab-1-run-1-0", scopeKey)).toBeUndefined();
    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)?.manualWhereInput).toBe("tenant_id = 7");
  });

  it("does not let a scope-miss empty builder overwrite visual rules (#8831)", () => {
    saveDataGridStructuredFilterState("data-tab-orders", {
      scopeKey,
      manualWhereInput: "",
      rules: [{ id: "r-id", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "`id` = 1",
      serverColumnFilters: {},
    });

    saveDataGridStructuredFilterState("data-tab-orders", {
      scopeKey: `${scopeKey}\0pending-columns`,
      manualWhereInput: "`id` = 1",
      rules: [{ id: "empty", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "",
      serverColumnFilters: {},
    });

    dropDataGridStructuredFilterMemoryCache();

    expect(loadDataGridStructuredFilterState("data-tab-orders", scopeKey)).toMatchObject({
      manualWhereInput: "",
      appliedWhereInput: "`id` = 1",
      rules: [{ columnName: "id", mode: "equals", rawValue: "1" }],
    });
  });

  it("still replaces visual rules when the same scope is cleared", () => {
    saveDataGridStructuredFilterState(cacheKey, {
      scopeKey,
      manualWhereInput: "",
      rules: [{ id: "empty", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      appliedWhereInput: "",
      serverColumnFilters: {},
    });

    dropDataGridStructuredFilterMemoryCache();

    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)).toMatchObject({
      manualWhereInput: "",
      appliedWhereInput: "",
      rules: [{ columnName: "" }],
    });
  });

  it("ignores corrupt stored payloads", () => {
    localStorage.setItem("dbx-data-grid-structured-filters", "{not json");
    dropDataGridStructuredFilterMemoryCache();
    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)).toBeUndefined();
  });

  it("keeps valid filter rules when a stored rule is invalid", () => {
    localStorage.setItem(
      "dbx-data-grid-structured-filters",
      JSON.stringify({
        version: 1,
        entries: [
          [
            cacheKey,
            {
              scopeKey,
              manualWhereInput: "",
              appliedWhereInput: "`id` = 1",
              rules: [
                { id: "bad", columnName: "status", mode: "not-a-mode", rawValue: "open", rawEndValue: "", conjunction: "AND" },
                { id: "r-id", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
              ],
              serverColumnFilters: { x: { condition: "bad" }, 0: { condition: "`id` = 1", keys: ["1"], labels: ["1"] } },
            },
          ],
        ],
      }),
    );
    dropDataGridStructuredFilterMemoryCache();

    expect(loadDataGridStructuredFilterState(cacheKey, scopeKey)).toMatchObject({
      appliedWhereInput: "`id` = 1",
      rules: [{ id: "r-id", columnName: "id", rawValue: "1" }],
      serverColumnFilters: { 0: { condition: "`id` = 1", keys: ["1"], labels: ["1"] } },
    });
  });
});
