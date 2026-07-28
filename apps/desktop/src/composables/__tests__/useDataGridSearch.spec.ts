import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataGridSearch } from "@/composables/useDataGridSearch";

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
