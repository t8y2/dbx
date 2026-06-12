import { describe, expect, it } from "vitest";
import { axisColumnLabel, chartableColumnIndexes, toChartNumber } from "@/lib/chartData";
import type { QueryResult } from "@/types/database";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return {
    columns,
    rows,
    affected_rows: rows.length,
    execution_time_ms: 1,
  };
}

describe("chartData", () => {
  it("accepts finite numbers and numeric strings", () => {
    expect(toChartNumber(42)).toBe(42);
    expect(toChartNumber("42.5")).toBe(42.5);
    expect(toChartNumber(" 1e3 ")).toBe(1000);
  });

  it("rejects non-finite and non-numeric values", () => {
    expect(toChartNumber("")).toBeNull();
    expect(toChartNumber("abc")).toBeNull();
    expect(toChartNumber(null)).toBeNull();
    expect(toChartNumber(true)).toBeNull();
  });

  it("finds numeric columns returned as strings", () => {
    expect(
      chartableColumnIndexes(
        result(
          ["name", "decimal_total", "status"],
          [
            ["a", "12.34", "ok"],
            ["b", "56.78", "ok"],
          ],
        ),
      ),
    ).toEqual([1]);
  });

  it("disambiguates duplicate axis labels by index", () => {
    expect(axisColumnLabel(["amount", "amount"], 0)).toBe("amount #1");
    expect(axisColumnLabel(["amount", "amount"], 1)).toBe("amount #2");
  });
});
