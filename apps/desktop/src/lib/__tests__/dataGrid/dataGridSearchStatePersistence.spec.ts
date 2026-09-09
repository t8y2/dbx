import { beforeEach, describe, expect, it } from "vitest";
import { clearDataGridSearchStates, clearDataGridSearchStatesForTab, createDataGridSearchScopeKey, dataGridSearchStateCount, loadDataGridSearchState, saveDataGridSearchState, type DataGridSearchCacheState } from "@/lib/dataGrid/dataGridSearchStatePersistence";

const SCOPE = createDataGridSearchScopeKey(["id", "name"]);

function state(overrides: Partial<DataGridSearchCacheState> = {}): DataGridSearchCacheState {
  return {
    scopeKey: SCOPE,
    searchText: "ada",
    deferredSearchText: "ada",
    overlayVisible: true,
    currentMatchIndex: 3,
    ...overrides,
  };
}

describe("dataGridSearchStatePersistence", () => {
  beforeEach(() => clearDataGridSearchStates());

  it("round-trips a saved state as a copy", () => {
    saveDataGridSearchState("tab-1", state());
    const loaded = loadDataGridSearchState("tab-1", SCOPE);
    expect(loaded).toEqual(state());
    loaded!.searchText = "mutated";
    expect(loadDataGridSearchState("tab-1", SCOPE)?.searchText).toBe("ada");
  });

  it("ignores a blank cache key", () => {
    saveDataGridSearchState(undefined, state());
    saveDataGridSearchState("  ", state());
    expect(dataGridSearchStateCount()).toBe(0);
    expect(loadDataGridSearchState(undefined, SCOPE)).toBeUndefined();
  });

  it("drops the entry when the column signature changed", () => {
    saveDataGridSearchState("tab-1", state());
    expect(loadDataGridSearchState("tab-1", createDataGridSearchScopeKey(["id", "renamed"]))).toBeUndefined();
    // The stale entry is evicted, not merely skipped.
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeUndefined();
    expect(dataGridSearchStateCount()).toBe(0);
  });

  it("does not store an empty closed search bar", () => {
    saveDataGridSearchState("tab-1", state({ searchText: "", deferredSearchText: "", overlayVisible: false }));
    expect(dataGridSearchStateCount()).toBe(0);
  });

  it("keeps an empty query while the bar is still open", () => {
    saveDataGridSearchState("tab-1", state({ searchText: "", deferredSearchText: "", overlayVisible: true }));
    expect(loadDataGridSearchState("tab-1", SCOPE)?.overlayVisible).toBe(true);
  });

  it("clears the entry when a later save empties the search", () => {
    saveDataGridSearchState("tab-1", state());
    saveDataGridSearchState("tab-1", state({ searchText: "", deferredSearchText: "", overlayVisible: false }));
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeUndefined();
  });

  it("evicts the least recently used entry past the cap", () => {
    for (let index = 0; index < 130; index += 1) saveDataGridSearchState(`tab-${index}`, state());
    expect(dataGridSearchStateCount()).toBe(128);
    expect(loadDataGridSearchState("tab-0", SCOPE)).toBeUndefined();
    expect(loadDataGridSearchState("tab-129", SCOPE)).toBeDefined();
  });

  it("treats a load as a recency touch", () => {
    saveDataGridSearchState("tab-keep", state());
    for (let index = 0; index < 127; index += 1) saveDataGridSearchState(`tab-${index}`, state());
    loadDataGridSearchState("tab-keep", SCOPE);
    saveDataGridSearchState("tab-overflow", state());
    expect(loadDataGridSearchState("tab-keep", SCOPE)).toBeDefined();
  });

  it("clears every cache key belonging to a closed tab", () => {
    saveDataGridSearchState("tab-1", state());
    saveDataGridSearchState("tab-1-run-1-0-rev-2", state());
    saveDataGridSearchState("tab-2", state());
    clearDataGridSearchStatesForTab("tab-1");
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeUndefined();
    expect(loadDataGridSearchState("tab-1-run-1-0-rev-2", SCOPE)).toBeUndefined();
    expect(loadDataGridSearchState("tab-2", SCOPE)).toBeDefined();
  });
});
