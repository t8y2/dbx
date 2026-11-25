import type { QueryResult } from "@/types/database";

export function toChartNumber(value: QueryResult["rows"][number][number]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isChartableValue(value: QueryResult["rows"][number][number]): boolean {
  return toChartNumber(value) !== null;
}

export function chartableColumnIndexes(result: QueryResult): number[] {
  return result.columns.map((_, index) => index).filter((index) => result.rows.some((row) => isChartableValue(row[index])));
}

/**
 * Parse a cell value into an epoch-millisecond timestamp for a time axis.
 * Accepts RFC3339 / ISO-8601 date strings and epoch numbers at second,
 * millisecond, microsecond or nanosecond precision (InfluxDB uses ns).
 * Returns null for anything that is not a recognizable timestamp.
 */
export function toChartTimestamp(value: QueryResult["rows"][number][number]): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Date.parse(trimmed);
    // Date.parse accepts plain numbers like "42"; require a date-like shape.
    const looksLikeDate = /^\d{4}-\d{2}-\d{2}([T\s].*)?$/.test(trimmed);
    return looksLikeDate && Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  const abs = Math.abs(value);
  // Heuristic by magnitude: s (1e9), ms (1e12), us (1e15), ns (1e18).
  if (abs >= 1e17) return value / 1e6;
  if (abs >= 1e14) return value / 1e3;
  if (abs >= 1e11) return value;
  if (abs >= 1e9) return value * 1e3;
  return null;
}

/**
 * Return epoch-ms timestamps for every row of a column, or null when the
 * column is not entirely made of timestamps (an empty result is not a time axis).
 */
export function timeColumnTimestamps(result: QueryResult, columnIndex: number): number[] | null {
  if (columnIndex < 0 || columnIndex >= result.columns.length || result.rows.length === 0) return null;
  const timestamps: number[] = [];
  for (const row of result.rows) {
    const ts = toChartTimestamp(row[columnIndex]);
    if (ts === null) return null;
    timestamps.push(ts);
  }
  return timestamps;
}

export function axisColumnLabel(columns: string[], index: number): string {
  const name = columns[index] ?? `#${index + 1}`;
  if (columns.filter((column) => column === name).length <= 1) return name;
  return `${name} #${index + 1}`;
}

export type ChartType = "line" | "bar" | "pie";

/** How the horizontal axis is scaled: inferred from data, or forced by the user. */
export type XAxisType = "auto" | "category" | "time";

export interface QueryChartOptionConfig {
  chartType: ChartType;
  xColumnIndex: number;
  yColumnIndexes: number[];
  showLabels?: boolean;
  isDark?: boolean;
  xAxisType?: XAxisType;
}

export function buildQueryChartOption(result: QueryResult, config: QueryChartOptionConfig) {
  const { chartType, xColumnIndex, yColumnIndexes, showLabels = false, isDark = false, xAxisType = "auto" } = config;
  if (xColumnIndex < 0 || yColumnIndexes.length === 0) return null;

  const xData = result.rows.map((row) => String(row[xColumnIndex] ?? ""));

  if (chartType === "pie") {
    const yIdx = yColumnIndexes[0];
    if (yIdx < 0 || yIdx >= result.columns.length) return null;
    return {
      tooltip: { trigger: "item" },
      legend: { bottom: 0, textStyle: { color: isDark ? "#ccc" : "#333" } },
      series: [
        {
          type: "pie",
          radius: ["30%", "60%"],
          data: xData.map((name, i) => ({
            name,
            value: toChartNumber(result.rows[i]?.[yIdx]) ?? 0,
          })),
          label: {
            show: true,
            formatter: showLabels ? "{b}: {c}" : "{b}",
            color: isDark ? "#ccc" : "#333",
            fontSize: 11,
          },
        },
      ],
    };
  }

  const yIndices = yColumnIndexes.filter((index) => index >= 0 && index < result.columns.length);
  if (yIndices.length === 0) return null;

  // Resolve the horizontal-axis scale. "auto" infers a time axis when every X
  // value is a timestamp (InfluxDB style); "time"/"category" force the user's
  // choice. In forced time mode unparseable values become null so ECharts skips
  // them instead of drawing them at a bogus position.
  let timestamps: (number | null)[] | null = null;
  if (xAxisType === "time") {
    timestamps = result.rows.map((row) => toChartTimestamp(row[xColumnIndex]));
  } else if (xAxisType === "auto") {
    timestamps = timeColumnTimestamps(result, xColumnIndex);
  }
  const xAxis = timestamps ? { type: "time" as const, axisLabel: { color: isDark ? "#aaa" : "#666" } } : { type: "category" as const, data: xData, axisLabel: { color: isDark ? "#aaa" : "#666" } };

  return {
    tooltip: { trigger: "axis" },
    legend: {
      bottom: 0,
      textStyle: { color: isDark ? "#ccc" : "#333" },
    },
    grid: { left: 60, right: 20, top: showLabels ? 28 : 20, bottom: 40 },
    xAxis,
    yAxis: {
      type: "value" as const,
      axisLabel: { color: isDark ? "#aaa" : "#666" },
    },
    series: yIndices.map((yIdx) => ({
      name: axisColumnLabel(result.columns, yIdx),
      type: chartType,
      data: result.rows.map((row, rowIndex) => {
        const value = toChartNumber(row[yIdx]) ?? 0;
        return timestamps ? [timestamps[rowIndex], value] : value;
      }),
      smooth: chartType === "line",
      label: {
        show: showLabels,
        position: "top" as const,
        color: isDark ? "#ccc" : "#333",
        fontSize: 11,
      },
      ...(showLabels ? { labelLayout: { hideOverlap: true } } : {}),
    })),
  };
}
