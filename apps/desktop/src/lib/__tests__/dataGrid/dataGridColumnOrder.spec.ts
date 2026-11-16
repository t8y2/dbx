import { describe, expect, it } from "vitest";
import { columnNamesInIndexOrder, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";

describe("columnNamesInIndexOrder", () => {
  /**
   * #14836: the WHERE field dropdown has to follow the order the user arranged the
   * columns into, not the order the result returned them in.
   */
  it("returns column names in the given display order", () => {
    const columns = ["id", "name", "created_at"];
    // User dragged created_at first, then id, then name.
    expect(columnNamesInIndexOrder(columns, [2, 0, 1])).toEqual(["created_at", "id", "name"]);
  });

  it("keeps the result order when the layout is untouched", () => {
    const columns = ["id", "name"];
    expect(columnNamesInIndexOrder(columns, [0, 1])).toEqual(["id", "name"]);
  });

  it("skips indexes that no longer resolve to a column", () => {
    const columns = ["id", "name"];
    expect(columnNamesInIndexOrder(columns, [1, 5, 0])).toEqual(["name", "id"]);
  });

  it("keeps duplicate names as separate entries", () => {
    const columns = ["total", "total"];
    const keys = uniqueDataGridColumnOrderKeys(columns);
    expect(keys).toHaveLength(2);
    expect(columnNamesInIndexOrder(columns, [1, 0])).toEqual(["total", "total"]);
  });
});
