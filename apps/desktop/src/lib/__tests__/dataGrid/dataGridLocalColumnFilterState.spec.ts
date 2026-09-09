import { describe, expect, it } from "vitest";
import { buildDataGridLocalFilterOptions, dataGridLocalFilterKey, restoreDataGridLocalColumnFilters, rowMatchesDataGridLocalColumnFilters, serializeDataGridLocalColumnFilters } from "@/lib/dataGrid/dataGridLocalColumnFilterState";

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

  it("builds stable keys and filters rows across multiple columns", () => {
    expect(dataGridLocalFilterKey(null)).toBe("__dbx_null__");
    expect(dataGridLocalFilterKey(true)).toBe("bool:true");
    expect(dataGridLocalFilterKey(42)).toBe("num:42");
    expect(dataGridLocalFilterKey("active")).toBe("str:active");

    expect(rowMatchesDataGridLocalColumnFilters(["active", 42], { 0: new Set(["str:active"]), 1: new Set(["num:42"]) })).toBe(true);
    expect(rowMatchesDataGridLocalColumnFilters(["active", 7], { 0: new Set(["str:active"]), 1: new Set(["num:42"]) })).toBe(false);
  });

  it("deduplicates local filter options and sorts null first", () => {
    const options = buildDataGridLocalFilterOptions({
      rows: [{ values: ["beta"] }, { values: [null] }, { values: ["beta"] }],
      newRows: [["alpha"]],
      columnIndex: 0,
      getRowData: (row) => row.values,
      formatValue: (value) => String(value),
    });

    expect(options).toEqual([
      { key: "__dbx_null__", label: "NULL", count: 1, value: null },
      { key: "str:alpha", label: "alpha", count: 1, value: "alpha" },
      { key: "str:beta", label: "beta", count: 2, value: "beta" },
    ]);
  });
});
