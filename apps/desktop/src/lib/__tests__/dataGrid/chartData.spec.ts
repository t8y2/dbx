import { describe, expect, it } from "vitest";
import { axisColumnLabel, buildQueryChartOption, chartableColumnIndexes, toChartNumber } from "@/lib/dataGrid/chartData";
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

  describe("buildQueryChartOption", () => {
    const testResult = result(
      ["category", "sales", "cost"],
      [
        ["Product A", 150, 90],
        ["Product B", 280, 140],
      ],
    );

    it("returns null when xColumnIndex is negative or yColumnIndexes is empty", () => {
      expect(buildQueryChartOption(testResult, { chartType: "bar", xColumnIndex: -1, yColumnIndexes: [1] })).toBeNull();
      expect(buildQueryChartOption(testResult, { chartType: "bar", xColumnIndex: 0, yColumnIndexes: [] })).toBeNull();
      expect(buildQueryChartOption(testResult, { chartType: "bar", xColumnIndex: 0, yColumnIndexes: [99] })).toBeNull();
    });

    it("builds bar chart with showLabels disabled by default", () => {
      const option = buildQueryChartOption(testResult, {
        chartType: "bar",
        xColumnIndex: 0,
        yColumnIndexes: [1],
      });

      expect(option).not.toBeNull();
      expect(option?.grid).toEqual({ left: 60, right: 20, top: 20, bottom: 40 });
      expect(option?.series).toHaveLength(1);
      expect(option?.series[0]).toMatchObject({
        name: "sales",
        type: "bar",
        data: [150, 280],
        label: {
          show: false,
          position: "top",
          color: "#333",
          fontSize: 11,
        },
      });
      expect(option?.series[0].labelLayout).toBeUndefined();
    });

    it("builds bar chart with showLabels enabled and dark theme", () => {
      const option = buildQueryChartOption(testResult, {
        chartType: "bar",
        xColumnIndex: 0,
        yColumnIndexes: [1, 2],
        showLabels: true,
        isDark: true,
      });

      expect(option).not.toBeNull();
      expect(option?.grid).toEqual({ left: 60, right: 20, top: 28, bottom: 40 });
      expect(option?.series).toHaveLength(2);
      expect(option?.series[0].label).toEqual({
        show: true,
        position: "top",
        color: "#ccc",
        fontSize: 11,
      });
      expect(option?.series[1].label).toEqual({
        show: true,
        position: "top",
        color: "#ccc",
        fontSize: 11,
      });
      expect(option?.series[0].labelLayout).toEqual({ hideOverlap: true });
      expect(option?.series[1].labelLayout).toEqual({ hideOverlap: true });
    });

    it("builds line chart with showLabels enabled", () => {
      const option = buildQueryChartOption(testResult, {
        chartType: "line",
        xColumnIndex: 0,
        yColumnIndexes: [1],
        showLabels: true,
        isDark: false,
      });

      expect(option).not.toBeNull();
      expect(option?.series[0]).toMatchObject({
        name: "sales",
        type: "line",
        smooth: true,
        data: [150, 280],
        label: {
          show: true,
          position: "top",
          color: "#333",
        },
      });
    });

    it("builds pie chart formatting values when showLabels is enabled", () => {
      const withoutLabels = buildQueryChartOption(testResult, {
        chartType: "pie",
        xColumnIndex: 0,
        yColumnIndexes: [1],
        showLabels: false,
      });
      expect(withoutLabels?.series[0].label).toEqual({
        show: true,
        formatter: "{b}",
        color: "#333",
        fontSize: 11,
      });

      const withLabels = buildQueryChartOption(testResult, {
        chartType: "pie",
        xColumnIndex: 0,
        yColumnIndexes: [1],
        showLabels: true,
      });
      expect(withLabels?.series[0].label).toEqual({
        show: true,
        formatter: "{b}: {c}",
        color: "#333",
        fontSize: 11,
      });
    });
  });
});
