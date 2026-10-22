import { describe, expect, it } from "vitest";
import { formatFilterRawValue, formatFilterRawValues, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";
import { dataGridNullSuggestionFilterMode, toggleAllDataGridDistinctValueOptions } from "@/lib/dataGrid/dataGridDistinctValueSuggestions";

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
});
