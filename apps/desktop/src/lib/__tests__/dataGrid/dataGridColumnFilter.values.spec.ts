import { describe, expect, it } from "vitest";
import { filterModeIsSupportedForDatabase, filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, formatFilterRawValue, formatFilterRawValues, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";
import { dataGridNullSuggestionFilterMode, toggleAllDataGridDistinctValueOptions } from "@/lib/dataGrid/dataGridDistinctValueSuggestions";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

describe("data grid filter candidate value serialization", () => {
  it("keeps simple single values readable and quotes surrounding whitespace", () => {
    expect(formatFilterRawValue("active")).toBe("active");
    const raw = formatFilterRawValue(" active ");
    expect(raw).toBe("' active '");
    expect(parseFilterValue(raw)).toBe(" active ");
    expect(parseFilterValue(formatFilterRawValue("'quoted'"))).toBe("'quoted'");
  });

  it("round-trips commas, newlines, quotes, and the literal string null in lists", () => {
    const raw = formatFilterRawValues(["north,east", "line 1\nline 2", "O'Brien", "null"]);
    expect(parseFilterValues(raw)).toEqual(["north,east", "line 1\nline 2", "O'Brien", "null"]);
  });

  it("keeps exact decimal filter literals as text for lossless SQL generation", () => {
    const value = "9007199254740993.123456789012";
    expect(parseFilterValue(value, { data_type: "NUMBER(38,12)" }, "oceanbase-oracle")).toBe(value);
    expect(parseFilterValues(`'${value}', '${value}1'`, { data_type: "NUMBER(38,12)" }, "oceanbase-oracle")).toEqual([value, `${value}1`]);
  });

  it("keeps leading-zero text values when the column type is unknown", () => {
    // #13059: Number("0000000") is 0, so a text filter value lost its leading
    // zeros and was compared as an integer when the column type was missing.
    expect(parseFilterValue("0000000")).toBe("0000000");
    expect(parseFilterValue("00123")).toBe("00123");
    expect(parseFilterValue("-0007")).toBe("-0007");
    // Plain numeric literals keep their existing numeric coercion.
    expect(parseFilterValue("0")).toBe(0);
    expect(parseFilterValue("123")).toBe(123);
    expect(parseFilterValue("0.5")).toBe(0.5);
  });

  it("maps a selected NULL candidate to a null-aware single-value operator", () => {
    expect(dataGridNullSuggestionFilterMode("equals")).toBe("is-null");
    expect(dataGridNullSuggestionFilterMode("like")).toBe("is-null");
    expect(dataGridNullSuggestionFilterMode("not-equals")).toBe("is-not-null");
    expect(dataGridNullSuggestionFilterMode("not-like")).toBe("is-not-null");
  });

  it("keeps the negation when NULL is picked for a negated operator (#14365)", () => {
    // Picking NULL out of the value list under "does not start with" must ask for
    // NOT NULL rows; it used to fall through to `is-null` and invert the filter.
    expect(dataGridNullSuggestionFilterMode("not-begins-with")).toBe("is-not-null");
    expect(dataGridNullSuggestionFilterMode("not-ends-with")).toBe("is-not-null");
    // Positive operators keep asking for NULL rows.
    expect(dataGridNullSuggestionFilterMode("begins-with")).toBe("is-null");
    expect(dataGridNullSuggestionFilterMode("ends-with")).toBe("is-null");
  });

  it("decides the NULL mapping for every filter mode without falling through", () => {
    // Exhaustive over the union: a new mode fails the type check here until it is
    // listed, so it cannot silently inherit the positive `is-null` branch again.
    const negated = ["not-equals", "not-like", "not-between", "not-begins-with", "not-ends-with"] as const;
    const positive = ["equals", "like", "between", "begins-with", "ends-with", "is-null", "is-not-null", "is-blank", "is-not-blank", "less-than", "less-than-or-equal", "greater-than", "greater-than-or-equal", "in", "not-in"] as const;
    type MissingMode = Exclude<DataGridContextFilterMode, (typeof negated)[number] | (typeof positive)[number]>;
    const everyModeIsListed: [MissingMode] extends [never] ? true : never = true;
    expect(everyModeIsListed).toBe(true);

    for (const mode of negated) expect(dataGridNullSuggestionFilterMode(mode)).toBe("is-not-null");
    for (const mode of positive) expect(dataGridNullSuggestionFilterMode(mode)).toBe("is-null");
  });

  it("toggles all currently displayed candidates without removing hidden selections", () => {
    const options = [
      { key: "str:a", label: "a", value: "a", count: 2 },
      { key: "str:b", label: "b", value: "b", count: 1 },
    ];
    const hiddenSelection = new Map<string, string>([["str:manual", "manual"]]);

    const selected = toggleAllDataGridDistinctValueOptions(hiddenSelection, options);
    expect([...selected.entries()]).toEqual([
      ["str:manual", "manual"],
      ["str:a", "a"],
      ["str:b", "b"],
    ]);

    const cleared = toggleAllDataGridDistinctValueOptions(selected, options);
    expect([...cleared.entries()]).toEqual([["str:manual", "manual"]]);
  });

  it("treats the negated prefix/suffix modes as supported value filters (#14365)", () => {
    for (const mode of ["not-begins-with", "not-ends-with"] as const) {
      expect(filterModeIsSupportedForDatabase(mode, "postgres")).toBe(true);
      expect(filterModeIsSupportedForDatabase(mode, "mysql")).toBe(true);
      expect(filterModeNeedsValue(mode)).toBe(true);
      expect(filterModeUsesList(mode)).toBe(false);
      expect(filterModeUsesRange(mode)).toBe(false);
    }
  });
});
