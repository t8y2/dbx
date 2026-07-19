import { nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridSearch } from "@/composables/useDataGridSearch";

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
    vi.useRealTimers();
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
    vi.useRealTimers();
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
});
