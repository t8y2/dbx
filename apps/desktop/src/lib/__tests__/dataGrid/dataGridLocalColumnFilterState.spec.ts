import { describe, expect, it } from "vitest";
import {
  buildDataGridLocalFilterOptions,
  dataGridLocalFilterKey,
  filterDataGridLocalFilterOptions,
  parseDataGridLocalFilterCountQuery,
  restoreDataGridLocalColumnFilters,
  rowMatchesDataGridLocalColumnFilters,
  serializeDataGridLocalColumnFilters,
  sortDataGridLocalFilterOptions,
  type DataGridLocalFilterOption,
} from "@/lib/dataGrid/dataGridLocalColumnFilterState";

function filterOption(label: string, count: number | null): DataGridLocalFilterOption {
  return { key: `str:${label}`, label, count, value: label };
}

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

  it("maps a saved filter to its current column after a dynamic column reorder", () => {
    const restored = restoreDataGridLocalColumnFilters(
      {
        "1": ["str:open"],
        "2": ["str:stale"],
      },
      3,
      ["id", "name", "status"],
      ["id", "status", "removed"],
    );

    expect(restored).toEqual({ 2: new Set(["str:open"]) });
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

  it("sorts filter options by count in both directions and treats a missing count as zero", () => {
    const options = [filterOption("beta", 2), filterOption("alpha", 5), filterOption("delta", null), filterOption("gamma", 1)];

    expect(sortDataGridLocalFilterOptions(options, { field: "count", direction: "asc" }).map((option) => option.label)).toEqual(["delta", "gamma", "beta", "alpha"]);
    expect(sortDataGridLocalFilterOptions(options, { field: "count", direction: "desc" }).map((option) => option.label)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("breaks equal-count ties by value ascending regardless of the count direction", () => {
    const options = [filterOption("delta", 3), filterOption("beta", 3), filterOption("alpha", 3)];

    expect(sortDataGridLocalFilterOptions(options, { field: "count", direction: "asc" }).map((option) => option.label)).toEqual(["alpha", "beta", "delta"]);
    expect(sortDataGridLocalFilterOptions(options, { field: "count", direction: "desc" }).map((option) => option.label)).toEqual(["alpha", "beta", "delta"]);
  });

  it("keeps null first for value ascending and last for value descending", () => {
    const options: DataGridLocalFilterOption[] = [filterOption("alpha", 1), { key: "__dbx_null__", label: "NULL", count: null, value: null }, filterOption("beta", 1)];

    expect(sortDataGridLocalFilterOptions(options, { field: "value", direction: "asc" }).map((option) => option.value)).toEqual([null, "alpha", "beta"]);
    expect(sortDataGridLocalFilterOptions(options, { field: "value", direction: "desc" }).map((option) => option.value)).toEqual(["beta", "alpha", null]);
  });

  it("returns a new sorted array without mutating the input options", () => {
    const options = [filterOption("beta", 2), filterOption("alpha", 5)];
    const snapshot = options.map((option) => ({ ...option }));

    const sorted = sortDataGridLocalFilterOptions(options, { field: "count", direction: "desc" });

    expect(sorted).not.toBe(options);
    expect(sorted.map((option) => option.label)).toEqual(["alpha", "beta"]);
    expect(options).toEqual(snapshot);
  });

  it("parses count comparison queries with all supported operators", () => {
    const gt = parseDataGridLocalFilterCountQuery(">1");
    expect(gt).not.toBeNull();
    expect(gt!(2)).toBe(true);
    expect(gt!(1)).toBe(false);
    expect(gt!(null)).toBe(false);

    const gte = parseDataGridLocalFilterCountQuery(">= 2");
    expect(gte).not.toBeNull();
    expect(gte!(2)).toBe(true);
    expect(gte!(1)).toBe(false);

    const lt = parseDataGridLocalFilterCountQuery("< 3");
    expect(lt).not.toBeNull();
    expect(lt!(2)).toBe(true);
    expect(lt!(3)).toBe(false);
    expect(lt!(null)).toBe(true);

    const lte = parseDataGridLocalFilterCountQuery("<= 2");
    expect(lte).not.toBeNull();
    expect(lte!(2)).toBe(true);
    expect(lte!(3)).toBe(false);

    const eq = parseDataGridLocalFilterCountQuery("=1");
    expect(eq).not.toBeNull();
    expect(eq!(1)).toBe(true);
    expect(eq!(2)).toBe(false);

    const eqDouble = parseDataGridLocalFilterCountQuery("== 1");
    expect(eqDouble).not.toBeNull();
    expect(eqDouble!(1)).toBe(true);

    const ne = parseDataGridLocalFilterCountQuery("!= 1");
    expect(ne).not.toBeNull();
    expect(ne!(2)).toBe(true);
    expect(ne!(1)).toBe(false);

    const neDiamond = parseDataGridLocalFilterCountQuery("<>1");
    expect(neDiamond).not.toBeNull();
    expect(neDiamond!(2)).toBe(true);
    expect(neDiamond!(1)).toBe(false);
  });

  it("parses count queries with count and 数量 prefixes", () => {
    const countPrefix = parseDataGridLocalFilterCountQuery("count: >1");
    expect(countPrefix).not.toBeNull();
    expect(countPrefix!(2)).toBe(true);
    expect(countPrefix!(1)).toBe(false);

    const countColon = parseDataGridLocalFilterCountQuery("count: 3");
    expect(countColon).not.toBeNull();
    expect(countColon!(3)).toBe(true);
    expect(countColon!(2)).toBe(false);

    const countEq = parseDataGridLocalFilterCountQuery("count=2");
    expect(countEq).not.toBeNull();
    expect(countEq!(2)).toBe(true);

    const zhGt = parseDataGridLocalFilterCountQuery("数量 > 2");
    expect(zhGt).not.toBeNull();
    expect(zhGt!(3)).toBe(true);
    expect(zhGt!(2)).toBe(false);

    const zhColon = parseDataGridLocalFilterCountQuery("数量: 1");
    expect(zhColon).not.toBeNull();
    expect(zhColon!(1)).toBe(true);
  });

  it("does not treat bare numbers or invalid queries as count filters", () => {
    expect(parseDataGridLocalFilterCountQuery("1")).toBeNull();
    expect(parseDataGridLocalFilterCountQuery("100")).toBeNull();
    expect(parseDataGridLocalFilterCountQuery("alpha")).toBeNull();
    expect(parseDataGridLocalFilterCountQuery("")).toBeNull();
    expect(parseDataGridLocalFilterCountQuery("   ")).toBeNull();
    expect(parseDataGridLocalFilterCountQuery(">abc")).toBeNull();
  });

  it("filters options by count while preserving literal label matches", () => {
    const options = [filterOption("apple", 5), filterOption("banana", 1), filterOption("orange", 2), filterOption(">1 special", 1)];

    // Filter duplicates (>1): matches apple (5), orange (2), and ">1 special" (label match)
    const duplicates = filterDataGridLocalFilterOptions(options, ">1");
    expect(duplicates.map((opt) => opt.label)).toEqual(["apple", "orange", ">1 special"]);

    // Filter unique (=1): matches banana (1) and ">1 special" (1)
    const uniques = filterDataGridLocalFilterOptions(options, "=1");
    expect(uniques.map((opt) => opt.label)).toEqual(["banana", ">1 special"]);

    // Normal text query: matches "an" -> banana, orange
    const textFiltered = filterDataGridLocalFilterOptions(options, "an");
    expect(textFiltered.map((opt) => opt.label)).toEqual(["banana", "orange"]);

    // Empty query returns all options
    expect(filterDataGridLocalFilterOptions(options, "")).toEqual(options);
  });
});
