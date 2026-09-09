import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridSearch } from "@/composables/useDataGridSearch";
import { clearDataGridSearchStates, createDataGridSearchScopeKey, loadDataGridSearchState, saveDataGridSearchState } from "@/lib/dataGrid/dataGridSearchStatePersistence";

afterEach(() => {
  vi.useRealTimers();
});

async function flushSearchDebounce() {
  await nextTick();
  vi.runOnlyPendingTimers();
  await nextTick();
  await nextTick();
}

describe("useDataGridSearch", () => {
  it("debounces matching across columns and cells", async () => {
    vi.useFakeTimers();
    // getCellSearchText 契约：返回小写文本（调用方负责缓存小写副本）
    const search = useDataGridSearch({ columns: ["id", "name"], rows: [[1, "Alice"]], getCellSearchText: (row, column) => String(row[column] ?? "").toLowerCase() });
    search.searchText.value = "ali";
    await nextTick();
    expect(search.matches.value).toEqual([]);
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(search.matches.value).toEqual([{ kind: "cell", displayRow: 0, col: 1 }]);
    // matchSet 用数值 key：(displayRow+1)*65536+col
    expect(search.matchSet.value.has((0 + 1) * 65536 + 1)).toBe(true);
    expect(search.matchCount.value).toBe(1);
    expect(search.matchAt(0)).toEqual({ kind: "cell", displayRow: 0, col: 1 });
  });

  it("shares one scan between match keys, set, and current-match access", async () => {
    vi.useFakeTimers();
    const getCellSearchText = vi.fn((row: string[], column: number) => row[column]);
    const search = useDataGridSearch({ columns: ["left", "right"], rows: [["hit", "hit"]], getCellSearchText });
    search.searchText.value = "hit";
    await flushSearchDebounce();

    expect(search.matchSet.value.size).toBe(2);
    expect(search.currentMatch.value).toEqual({ kind: "cell", displayRow: 0, col: 0 });
    expect(search.matchCount.value).toBe(2);
    expect(getCellSearchText).toHaveBeenCalledTimes(2);
  });

  it("keys column-name matches with displayRow -1", async () => {
    vi.useFakeTimers();
    const search = useDataGridSearch({ columns: ["id", "name"], rows: [], getCellSearchText: () => "" });
    search.searchText.value = "nam";
    await nextTick();
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(search.matches.value).toEqual([{ kind: "column", displayRow: -1, col: 1 }]);
    expect(search.matchSet.value.has((-1 + 1) * 65536 + 1)).toBe(true);
  });

  it("suggests columns and replaces only the active token", async () => {
    const columns = ref(["customer_id", "created_at"]);
    const search = useDataGridSearch({ columns, rows: [], getCellSearchText: () => "" });
    search.searchText.value = "status = cus";
    await nextTick();
    expect(search.suggestions.value).toEqual(["customer_id"]);
    expect(search.acceptSuggestion()).toBe(true);
    expect(search.searchText.value).toBe("status = customer_id");
  });

  it("navigates forward and backward with first/last wrapping", async () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const search = useDataGridSearch({
      columns: ["left", "right"],
      rows: [
        ["hit", "hit"],
        ["none", "hit"],
      ],
      getCellSearchText: (row, column) => row[column],
      onNavigate,
    });
    search.searchText.value = "hit";
    await flushSearchDebounce();

    expect(search.currentMatchIndex.value).toBe(0);
    search.navigateMatch(1);
    expect(search.currentMatchIndex.value).toBe(1);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "cell", displayRow: 0, col: 1 });

    search.navigateMatch(-1);
    expect(search.currentMatchIndex.value).toBe(0);
    search.navigateMatch(-1);
    expect(search.currentMatchIndex.value).toBe(2);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "cell", displayRow: 1, col: 1 });

    search.navigateMatch(1);
    expect(search.currentMatchIndex.value).toBe(0);
  });

  it("resets navigation when results change or the query is cleared", async () => {
    vi.useFakeTimers();
    const rows = ref([["hit"], ["hit"]]);
    const onNavigate = vi.fn();
    const search = useDataGridSearch({ columns: ["value"], rows, getCellSearchText: (row, column) => row[column], onNavigate });
    search.searchText.value = "hit";
    await flushSearchDebounce();
    search.navigateMatch(1);
    expect(search.currentMatchIndex.value).toBe(1);

    rows.value = [["hit"]];
    await nextTick();
    await nextTick();
    expect(search.currentMatchIndex.value).toBe(0);
    expect(search.currentMatch.value).toEqual({ kind: "cell", displayRow: 0, col: 0 });

    rows.value = [];
    await nextTick();
    expect(search.currentMatchIndex.value).toBe(-1);
    expect(search.currentMatch.value).toBeNull();

    rows.value = [["hit"]];
    await nextTick();
    search.searchText.value = "";
    await nextTick();
    expect(search.matches.value).toEqual([]);
    expect(search.currentMatchIndex.value).toBe(-1);
  });
});

describe("useDataGridSearch persistence (#8524)", () => {
  const COLUMNS = ["left", "right"];
  const SCOPE = createDataGridSearchScopeKey(COLUMNS);
  const ROWS = [
    ["hit", "hit"],
    ["none", "hit"],
  ];

  function createSearch({ onNavigate = vi.fn(), persistenceKey = "tab-1" as string | undefined } = {}) {
    const search = useDataGridSearch({
      columns: COLUMNS,
      rows: ROWS,
      getCellSearchText: (row: string[], column: number) => row[column],
      onNavigate,
      persistenceKey,
      persistenceScopeKey: () => SCOPE,
    });
    return { search, onNavigate };
  }

  beforeEach(() => clearDataGridSearchStates());

  it("persists the query, overlay and match index as the user searches", async () => {
    vi.useFakeTimers();
    const { search } = createSearch();
    search.overlayVisible.value = true;
    search.searchText.value = "hit";
    await flushSearchDebounce();
    search.navigateMatch(1);
    await nextTick();

    const saved = loadDataGridSearchState("tab-1", SCOPE);
    expect(saved).toMatchObject({ searchText: "hit", deferredSearchText: "hit", overlayVisible: true, currentMatchIndex: 1 });
  });

  it("restores text, overlay and match index without auto-navigating or debouncing", async () => {
    const { search, onNavigate } = createSearch();
    saveDataGridSearchState("tab-1", { scopeKey: SCOPE, searchText: "hit", deferredSearchText: "hit", overlayVisible: true, currentMatchIndex: 2 });

    expect(search.restorePersistedState()).toBe(true);
    // No advanceTimersByTime: the restore bypasses the debounce entirely.
    await nextTick();
    await nextTick();

    expect(search.overlayVisible.value).toBe(true);
    expect(search.deferredSearchText.value).toBe("hit");
    expect(search.matchCount.value).toBe(3);
    expect(search.currentMatchIndex.value).toBe(2);
    // The grid's own scroll restore owns the viewport when returning to a tab.
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("clamps a stale restored match index", async () => {
    const { search } = createSearch();
    saveDataGridSearchState("tab-1", { scopeKey: SCOPE, searchText: "none", deferredSearchText: "none", overlayVisible: true, currentMatchIndex: 9 });

    search.restorePersistedState();
    await nextTick();
    await nextTick();

    expect(search.matchCount.value).toBe(1);
    expect(search.currentMatchIndex.value).toBe(0);
  });

  it("does not reopen the suggestion popup on restore", async () => {
    const { search } = createSearch();
    saveDataGridSearchState("tab-1", { scopeKey: SCOPE, searchText: "le", deferredSearchText: "le", overlayVisible: true, currentMatchIndex: 0 });

    search.restorePersistedState();
    await nextTick();

    // "le" prefixes the "left" column, so the non-restore path would suggest it.
    expect(search.suggestions.value).toEqual([]);
    expect(search.suggestionIndex.value).toBe(-1);
  });

  it("does not restore across a column signature change", () => {
    const { search } = createSearch();
    saveDataGridSearchState("tab-1", { scopeKey: createDataGridSearchScopeKey(["renamed"]), searchText: "hit", deferredSearchText: "hit", overlayVisible: true, currentMatchIndex: 0 });

    expect(search.restorePersistedState()).toBe(false);
    expect(search.searchText.value).toBe("");
  });

  it("lets a keystroke during the restore window cancel the token", async () => {
    vi.useFakeTimers();
    const { search, onNavigate } = createSearch();
    saveDataGridSearchState("tab-1", { scopeKey: SCOPE, searchText: "hit", deferredSearchText: "hit", overlayVisible: true, currentMatchIndex: 2 });

    search.restorePersistedState();
    search.searchText.value = "none";
    await flushSearchDebounce();

    // Normal typing behaviour resumes: debounced, auto-navigated, index reset.
    expect(search.deferredSearchText.value).toBe("none");
    expect(search.currentMatchIndex.value).toBe(0);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("clears the persisted entry when the search bar is closed", async () => {
    vi.useFakeTimers();
    const { search } = createSearch();
    search.overlayVisible.value = true;
    search.searchText.value = "hit";
    await flushSearchDebounce();
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeDefined();

    search.close();
    await nextTick();
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeUndefined();
  });

  it("opts out entirely when the host passes no persistence key", async () => {
    vi.useFakeTimers();
    // Built without the helper: an explicit `undefined` argument would hit its
    // default and silently re-enable persistence.
    const search = useDataGridSearch({
      columns: COLUMNS,
      rows: ROWS,
      getCellSearchText: (row: string[], column: number) => row[column],
    });
    search.overlayVisible.value = true;
    search.searchText.value = "hit";
    await flushSearchDebounce();

    expect(search.restorePersistedState()).toBe(false);
    expect(loadDataGridSearchState("tab-1", SCOPE)).toBeUndefined();
  });
});
