/**
 * Option builders for the `{ name, value }`-only family: `pie` and `funnel`.
 *
 * Both take the same payload; a funnel merely replaces the donut radius with its
 * own layout defaults (descending sort, centered). Keeping them together keeps
 * the shared legend/tooltip/theme treatment in one place.
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
        // ECharts defaults are descending / vertical / centered, but they are
        // stated explicitly so a future default change cannot reorder the stages
        // the model already listed in priority order.
        sort: "descending",
        gap: 2,
        left: "10%",
        right: "10%",
        data: spec.data.map((entry) => ({ name: entry.name, value: entry.value })),
      },
    ],
  };
}
