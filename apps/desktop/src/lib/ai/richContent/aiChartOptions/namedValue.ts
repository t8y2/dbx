/**
 * Option builders for the `{ name, value }`-only family: `pie` and `funnel`.
 *
 * Both take the same payload; a funnel merely replaces the donut radius with its
 * own layout defaults (input order, centered). Keeping them together keeps the
 * shared legend/tooltip/theme treatment in one place.
 */

import type { EChartsOption } from "echarts";
import { chartTitleOption, legendTextStyle } from "@/lib/ai/richContent/aiChartOptions/theme";
import type { AiChartTheme, FunnelAiChartSpec, PieAiChartSpec } from "@/lib/ai/richContent/aiChartShared";

export function buildPieOption(spec: PieAiChartSpec, theme: AiChartTheme): EChartsOption {
  return {
    aria: { enabled: true },
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: legendTextStyle(theme) },
    title: chartTitleOption(spec.title, theme),
    series: [
      {
        type: "pie",
        radius: ["30%", "60%"],
        data: spec.data.map((entry) => ({ name: entry.name, value: entry.value })),
      },
    ],
  };
}

export function buildFunnelOption(spec: FunnelAiChartSpec, theme: AiChartTheme): EChartsOption {
  return {
    aria: { enabled: true },
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: legendTextStyle(theme) },
    title: chartTitleOption(spec.title, theme),
    series: [
      {
        type: "funnel",
        // `sort: "none"` keeps the data order. ECharts' default ('descending')
        // sorts the stages by value (funnelLayout: `sort !== 'none'` triggers the
        // value comparator), which reorders the business process itself whenever
        // the model's stages are not monotonic. The stages are listed in process
        // order, so that order must win over the magnitude.
        sort: "none",
        gap: 2,
        left: "10%",
        right: "10%",
        data: spec.data.map((entry) => ({ name: entry.name, value: entry.value })),
      },
    ],
  };
}
