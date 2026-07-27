import { describe, expect, it } from "vitest";
import { restoreDataGridLocalColumnFilters, serializeDataGridLocalColumnFilters } from "@/lib/dataGrid/dataGridLocalColumnFilterState";

describe("data grid local column filter state", () => {
  it("round-trips selected values so a remounted grid restores its filters", () => {
    const serialized = serializeDataGridLocalColumnFilters({
      0: new Set(["str:active", "__dbx_null__"]),
      2: new Set(["num:42"]),
    });

    const restored = restoreDataGridLocalColumnFilters(serialized, 3);

    expect(restored[0]).toEqual(new Set(["str:active", "__dbx_null__"]));
    expect(restored[2]).toEqual(new Set(["num:42"]));
  });

  it("drops invalid columns and empty filters before restoring state", () => {
    const restored = restoreDataGridLocalColumnFilters(
      {
        "-1": ["str:invalid"],
        "1": [],
        "4": ["str:out-of-range"],
        nope: ["str:invalid"],
      },
      3,
    );

    expect(restored).toEqual({});
  });
});
