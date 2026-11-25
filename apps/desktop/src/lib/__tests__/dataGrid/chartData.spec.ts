import { describe, expect, it } from "vitest";
import { axisColumnLabel, buildQueryChartOption, chartableColumnIndexes, timeColumnTimestamps, toChartNumber, toChartTimestamp } from "@/lib/dataGrid/chartData";
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

  describe("toChartTimestamp", () => {
    it("parses RFC3339 timestamps returned by InfluxDB", () => {
      expect(toChartTimestamp("2026-11-25T10:00:00Z")).toBe(Date.parse("2026-11-25T10:00:00Z"));
      expect(toChartTimestamp("2026-11-25T10:30:00.123Z")).toBe(Date.parse("2026-11-25T10:30:00.123Z"));
      expect(toChartTimestamp("2026-11-25T18:00:00+08:00")).toBe(Date.parse("2026-11-25T18:00:00+08:00"));
    });

    it("parses numeric epoch timestamps by magnitude (seconds/ms/us/ns)", () => {
      expect(toChartTimestamp(1700000000)).toBe(1700000000000);
      expect(toChartTimestamp(1700000000000)).toBe(1700000000000);
      expect(toChartTimestamp(1700000000000000)).toBe(1700000000000);
      expect(toChartTimestamp(1700000000000000000)).toBe(1700000000000);
    });

    it("rejects values that are not timestamps", () => {
      expect(toChartTimestamp("not a time")).toBeNull();
      expect(toChartTimestamp("42")).toBeNull();
      expect(toChartTimestamp(null)).toBeNull();
      expect(toChartTimestamp(true)).toBeNull();
      expect(toChartTimestamp(123)).toBeNull();
    });
  });

  describe("timeColumnTimestamps", () => {
    it("detects an RFC3339 time column and returns epoch ms per row", () => {
      const timed = result(
        ["time", "value"],
        [
          ["2026-11-25T10:00:00Z", 1],
          ["2026-11-25T10:30:00Z", 2],
          ["2026-11-25T10:35:00Z", 3],
        ],
      );
      expect(timeColumnTimestamps(timed, 0)).toEqual([Date.parse("2026-11-25T10:00:00Z"), Date.parse("2026-11-25T10:30:00Z"), Date.parse("2026-11-25T10:35:00Z")]);
    });

    it("returns null when any row lacks a parseable timestamp", () => {
      const mixed = result(
        ["time", "value"],
        [
          ["2026-11-25T10:00:00Z", 1],
          ["bad", 2],
        ],
      );
      expect(timeColumnTimestamps(mixed, 0)).toBeNull();
      expect(timeColumnTimestamps(mixed, 1)).toBeNull();
    });
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

    it("builds a time axis with [timestamp, value] pairs when X is a time column", () => {
      const timed = result(
        ["time", "usage", "idle"],
        [
          ["2026-11-25T10:00:00Z", 10, 90],
          ["2026-11-25T10:30:00Z", 20, 80],
          ["2026-11-25T10:35:00Z", 30, 70],
        ],
      );
      const option = buildQueryChartOption(timed, {
        chartType: "line",
        xColumnIndex: 0,
        yColumnIndexes: [1, 2],
      });

      expect(option?.xAxis).toMatchObject({ type: "time" });
      expect(option?.xAxis).not.toHaveProperty("data");
      expect(option?.series[0].data).toEqual([
        [Date.parse("2026-11-25T10:00:00Z"), 10],
        [Date.parse("2026-11-25T10:30:00Z"), 20],
        [Date.parse("2026-11-25T10:35:00Z"), 30],
      ]);
      expect(option?.series[1].data).toEqual([
        [Date.parse("2026-11-25T10:00:00Z"), 90],
        [Date.parse("2026-11-25T10:30:00Z"), 80],
        [Date.parse("2026-11-25T10:35:00Z"), 70],
      ]);
    });

    it("keeps a category axis when X is not a time column", () => {
      const option = buildQueryChartOption(testResult, {
        chartType: "line",
        xColumnIndex: 0,
        yColumnIndexes: [1],
      });
      expect(option?.xAxis).toMatchObject({ type: "category", data: ["Product A", "Product B"] });
      expect(option?.series[0].data).toEqual([150, 280]);
    });

    it("uses time axis for numeric epoch X column", () => {
      const timed = result(
        ["ts", "value"],
        [
          [1700000000, 1],
          [1700000300, 2],
        ],
      );
      const option = buildQueryChartOption(timed, { chartType: "line", xColumnIndex: 0, yColumnIndexes: [1] });
      expect(option?.xAxis).toMatchObject({ type: "time" });
      expect(option?.series[0].data).toEqual([
        [1700000000000, 1],
        [1700000300000, 2],
      ]);
    });

    it("pie chart keeps string category labels even when X is a time column", () => {
      const timed = result(
        ["time", "value"],
        [
          ["2026-11-25T10:00:00Z", 10],
          ["2026-11-25T10:30:00Z", 20],
        ],
      );
      const option = buildQueryChartOption(timed, { chartType: "pie", xColumnIndex: 0, yColumnIndexes: [1] });
      expect(option?.series[0].data).toEqual([
        { name: "2026-11-25T10:00:00Z", value: 10 },
        { name: "2026-11-25T10:30:00Z", value: 20 },
      ]);
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
