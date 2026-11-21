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

export function axisColumnLabel(columns: string[], index: number): string {
  const name = columns[index] ?? `#${index + 1}`;
  if (columns.filter((column) => column === name).length <= 1) return name;
  return `${name} #${index + 1}`;
}

export type ChartType = "line" | "bar" | "pie";

export interface QueryChartOptionConfig {
  chartType: ChartType;
  xColumnIndex: number;
  yColumnIndexes: number[];
  showLabels?: boolean;
  isDark?: boolean;
}

export function buildQueryChartOption(result: QueryResult, config: QueryChartOptionConfig) {
  const { chartType, xColumnIndex, yColumnIndexes, showLabels = false, isDark = false } = config;
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

  return {
    tooltip: { trigger: "axis" },
    legend: {
      bottom: 0,
      textStyle: { color: isDark ? "#ccc" : "#333" },
    },
    grid: { left: 60, right: 20, top: showLabels ? 28 : 20, bottom: 40 },
    xAxis: {
      type: "category" as const,
      data: xData,
      axisLabel: { color: isDark ? "#aaa" : "#666" },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: { color: isDark ? "#aaa" : "#666" },
    },
    series: yIndices.map((yIdx) => ({
      name: axisColumnLabel(result.columns, yIdx),
      type: chartType,
      data: result.rows.map((row) => toChartNumber(row[yIdx]) ?? 0),
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
