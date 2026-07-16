import { nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridSearch } from "@/composables/useDataGridSearch";

describe("useDataGridSearch", () => {
  it("debounces matching across columns and cells", async () => {
    vi.useFakeTimers();
    const search = useDataGridSearch({ columns: ["id", "name"], rows: [[1, "Alice"]], getCellText: (row, column) => String(row[column] ?? "") });
    search.searchText.value = "ali";
    await nextTick();
    expect(search.matches.value).toEqual([]);
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(search.matches.value).toEqual([{ kind: "cell", displayRow: 0, col: 1 }]);
    vi.useRealTimers();
  });

  it("suggests columns and replaces only the active token", async () => {
    const columns = ref(["customer_id", "created_at"]);
    const search = useDataGridSearch({ columns, rows: [], getCellText: () => "" });
    search.searchText.value = "status = cus";
    await nextTick();
    expect(search.suggestions.value).toEqual(["customer_id"]);
    expect(search.acceptSuggestion()).toBe(true);
    expect(search.searchText.value).toBe("status = customer_id");
  });
});
