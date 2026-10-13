import { describe, expect, it } from "vitest";
import { allNullColumnIndexes } from "@/lib/dataGrid/dataGridColumnVisibility";

describe("empty column detection", () => {
  it("keeps the old NULL-only behavior and opts into mixed NULL/empty strings", () => {
    const rows = [
      [null, null, "", 0, false, " ", undefined],
      [null, "", "", 0, false, "", undefined],
    ];
    const indexes = [0, 1, 2, 3, 4, 5, 6];
    expect(allNullColumnIndexes(rows, indexes)).toEqual([0]);
    expect(allNullColumnIndexes(rows, indexes, true)).toEqual([0, 1, 2]);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("never hides columns based on an empty result or missing cells", () => {
    expect(allNullColumnIndexes([], [0, 1], true)).toEqual([]);
    expect(allNullColumnIndexes([[null], []], [0, 1], true)).toEqual([]);
    expect(
      allNullColumnIndexes(
        [
          [null, ""],
          ["value", ""],
        ],
        [0, 1],
        true,
      ),
    ).toEqual([1]);
  });
});
