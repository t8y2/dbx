import { describe, expect, it } from "vitest";
import { useDataGridSort } from "@/composables/useDataGridSort";

describe("useDataGridSort", () => {
  it("stores the selected database or local sort state", () => {
    const sort = useDataGridSort();

    sort.setSort("name", 2, "desc", "local");

    expect(sort.sortColumn.value).toBe("name");
    expect(sort.sortColumnIndex.value).toBe(2);
    expect(sort.sortDirection.value).toBe("desc");
    expect(sort.sortMode.value).toBe("local");
  });

  it("resets to the default unsorted state", () => {
    const sort = useDataGridSort();
    sort.setSort("name", 2, "desc", "local");

    sort.clearSort();

    expect(sort.sortColumn.value).toBeNull();
    expect(sort.sortColumnIndex.value).toBeNull();
    expect(sort.sortDirection.value).toBe("asc");
    expect(sort.sortMode.value).toBe("database");
  });
});
