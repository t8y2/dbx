/**
 * UI adapter from a normalized {@link AiChartSpec} to an ECharts option.
 * Decoupled from the wire protocol: only the builders in `aiChartOptions/*` know
 * how a spec maps onto ECharts, so the protocol layer never needs to reason about
 * rendering and the renderer never sees the raw chart-json.
 *
 * The dispatch below is the single place that decides which builder owns a
 * spec — adding a chart type is one branch here plus its builder module.
 */

import type { EChartsOption } from "echarts";
import { buildCartesianOption } from "@/lib/ai/richContent/aiChartOptions/cartesian";
import { buildHeatmapOption } from "@/lib/ai/richContent/aiChartOptions/heatmap";
import { buildFunnelOption, buildPieOption } from "@/lib/ai/richContent/aiChartOptions/namedValue";
import { buildScatterOption } from "@/lib/ai/richContent/aiChartOptions/scatter";
import type { AiChartSpec, AiChartTheme } from "@/lib/ai/richContent/aiChartShared";

export type { AiChartTheme } from "@/lib/ai/richContent/aiChartShared";

export function buildAiChartOption(spec: AiChartSpec, theme: AiChartTheme): EChartsOption {
  switch (spec.type) {
    case "pie":
      return buildPieOption(spec, theme);
    case "funnel":
      return buildFunnelOption(spec, theme);
    case "scatter":
      return buildScatterOption(spec, theme);
    case "heatmap":
      return buildHeatmapOption(spec, theme);
    case "line":
    case "bar":
    case "pictorialBar":
      return buildCartesianOption(spec, theme);
  }
}
